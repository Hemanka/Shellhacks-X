from __future__ import annotations

from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from time import perf_counter

from ..traversability.connect_target_obj import connect_target_object
from .navigation_algo import a_star
from .types import (
    Direction,
    NavigationAction,
    NavigationDecision,
    PerceptionState,
    SectorObservation,
    SectorStatus,
)


@dataclass(frozen=True, slots=True)
class NavigationConfig:
    target_alignment_weight: float = 5.0
    open_base_score: float = 10.0
    open_confidence_weight: float = 2.0
    blocked_penalty: float = 100.0
    uncertainty_penalty: float = 20.0
    direction_switch_penalty: float = 3.0
    history_size: int = 3
    detour_forward_observations: int = 2


ACTION_DIRECTION = {
    NavigationAction.FORWARD: Direction.CENTER,
    NavigationAction.TURN_LEFT: Direction.LEFT,
    NavigationAction.TURN_RIGHT: Direction.RIGHT,
}


class CameraRelativeNavigator:
    """Choose one small action from one camera-relative observation."""

    def __init__(self, config: NavigationConfig | None = None, *, debug: bool = False) -> None:
        self.config = config or NavigationConfig()
        self.debug = debug
        self.history: deque[PerceptionState] = deque(maxlen=self.config.history_size)
        self.previous_action: NavigationAction | None = None
        self.detour_direction: Direction | None = None
        self.detour_forward_count = 0

    def reset(self) -> None:
        """Clear temporal state when the requested navigation target changes."""
        self.history.clear()
        self.previous_action = None
        self.detour_direction = None
        self.detour_forward_count = 0

    def decide(
        self,
        perception: PerceptionState,
        grid: Sequence[Sequence[int]] | None = None,
    ) -> NavigationDecision:
        started = perf_counter()
        previous_action = self.previous_action

        grid_decision = self._grid_decision(perception, grid, started)
        if grid_decision is not None:
            decision = grid_decision
        else:
            decision = self._reactive_decision(perception, started, previous_action)

        self.history.append(perception)
        self.previous_action = decision.action
        if self.debug:
            print(format_debug(perception, decision))
        return decision

    def _reactive_decision(
        self,
        perception: PerceptionState,
        started: float,
        previous_action: NavigationAction | None,
    ) -> NavigationDecision:
        statuses = {
            perception.sectors.left.status,
            perception.sectors.center.status,
            perception.sectors.right.status,
        }
        if statuses == {SectorStatus.UNCERTAIN}:
            decision = self._nonmovement_decision(
                NavigationAction.REACQUIRE,
                perception,
                "All camera regions are uncertain; requesting another observation.",
                started,
            )
        elif statuses == {SectorStatus.BLOCKED}:
            decision = self._nonmovement_decision(
                NavigationAction.HOLD,
                perception,
                "All camera regions are blocked; holding position.",
                started,
            )
        else:
            effective_perception = self._with_recent_target(perception)
            if effective_perception is None:
                decision = self._nonmovement_decision(
                    NavigationAction.REACQUIRE,
                    perception,
                    "Target direction is unavailable; requesting another observation.",
                    started,
                )
            else:
                decision = self._detour_decision(effective_perception, started)
                if decision is None:
                    decision = self._scored_decision(
                        effective_perception, started, previous_action
                    )
        return decision

    def _grid_decision(
        self,
        perception: PerceptionState,
        grid: Sequence[Sequence[int]] | None,
        started: float,
    ) -> NavigationDecision | None:
        if grid is None:
            return None
        try:
            path = a_star(connect_target_object(grid))
        except (TypeError, ValueError):
            return None
        if not path:
            return None
        if len(path) == 1:
            action = NavigationAction.ARRIVED
            reason = "The A* path has reached the target object."
        else:
            (current_x, current_y), (next_x, next_y) = path[:2]
            horizontal_delta = next_x - current_x
            vertical_delta = next_y - current_y
            if horizontal_delta < 0:
                action = NavigationAction.TURN_LEFT
                reason = "A* selected the next open cell to the left."
            elif horizontal_delta > 0:
                action = NavigationAction.TURN_RIGHT
                reason = "A* selected the next open cell to the right."
            elif vertical_delta < 0:
                action = NavigationAction.FORWARD
                reason = "A* selected the next open cell ahead."
            else:
                action = NavigationAction.HOLD
                reason = "A* selected a reverse step, which is not supported."

        confidence_values = [perception.scene_confidence]
        if perception.target:
            confidence_values.append(perception.target.confidence)
        confidence = round(min(confidence_values), 3)
        return NavigationDecision(
            action=action,
            confidence=confidence,
            reason=reason,
            should_replan=action not in {
                NavigationAction.FORWARD,
                NavigationAction.ARRIVED,
            },
            candidate_scores={action: 0.0},
            previous_action=self.previous_action,
            latency_ms=(perf_counter() - started) * 1000,
        )

    def _with_recent_target(
        self, perception: PerceptionState
    ) -> PerceptionState | None:
        target = perception.target
        if target and target.visible and target.direction is not Direction.UNKNOWN:
            return perception

        recent_target = next(
            (
                item.target
                for item in reversed(self.history)
                if item.target
                and item.target.visible
                and item.target.direction is not Direction.UNKNOWN
            ),
            None,
        )
        if recent_target is None:
            return None
        return PerceptionState(
            timestamp=perception.timestamp,
            target=recent_target,
            sectors=perception.sectors,
            obstacles=perception.obstacles,
            scene_confidence=perception.scene_confidence,
        )

    def _detour_decision(
        self,
        perception: PerceptionState,
        started: float,
    ) -> NavigationDecision | None:
        center = perception.sectors.center
        scores = self._score_candidates(perception)

        if self.detour_direction is None and self._is_blocked(center):
            preferred = self._choose_detour_side(perception)
            if preferred is None:
                return None
            self.detour_direction = preferred
            self.detour_forward_count = 0
            action = (
                NavigationAction.TURN_LEFT
                if preferred is Direction.LEFT
                else NavigationAction.TURN_RIGHT
            )
            return self._movement_decision(
                perception,
                action,
                f"Center is blocked; begin passing the obstacle on the {preferred.value.lower()}.",
                scores,
                started,
            )

        if self.detour_direction is None:
            return None

        detour_sector = perception.sectors.for_direction(self.detour_direction)
        if center.status is SectorStatus.BLOCKED:
            if self._supports_movement(detour_sector):
                action = (
                    NavigationAction.TURN_LEFT
                    if self.detour_direction is Direction.LEFT
                    else NavigationAction.TURN_RIGHT
                )
                return self._movement_decision(
                    perception,
                    action,
                    f"Obstacle remains ahead; continue turning {self.detour_direction.value.lower()}.",
                    scores,
                    started,
                )
            return self._nonmovement_decision(
                NavigationAction.HOLD,
                perception,
                "Obstacle remains ahead and the detour side is not observed open.",
                started,
            )

        if not self._supports_movement(center):
            return self._nonmovement_decision(
                NavigationAction.HOLD,
                perception,
                "Hold while the center of the detour is checked again.",
                started,
            )

        if self.detour_forward_count < self.config.detour_forward_observations:
            self.detour_forward_count += 1
            return self._movement_decision(
                perception,
                NavigationAction.FORWARD,
                "Center is observed open; take one small step to pass the obstacle.",
                scores,
                started,
            )

        self.detour_direction = None
        self.detour_forward_count = 0
        return None

    def _scored_decision(
        self,
        perception: PerceptionState,
        started: float,
        previous_action: NavigationAction | None,
    ) -> NavigationDecision:
        scores = self._score_candidates(perception)
        # Right precedes left so a symmetric blocked-center frame resolves
        # deterministically for the dynamic-obstacle demo.
        movement_order = (
            NavigationAction.FORWARD,
            NavigationAction.TURN_RIGHT,
            NavigationAction.TURN_LEFT,
            NavigationAction.HOLD,
        )
        action = max(movement_order, key=lambda candidate: scores[candidate])
        selected_sector = (
            perception.sectors.for_direction(ACTION_DIRECTION[action])
            if action in ACTION_DIRECTION
            else None
        )
        confidence = self._decision_confidence(perception, selected_sector)
        return NavigationDecision(
            action=action,
            confidence=confidence,
            reason=self._reason(perception, action, selected_sector),
            should_replan=action is not NavigationAction.FORWARD,
            candidate_scores=scores,
            previous_action=previous_action,
            latency_ms=(perf_counter() - started) * 1000,
        )

    def _movement_decision(
        self,
        perception: PerceptionState,
        action: NavigationAction,
        reason: str,
        scores: dict[NavigationAction, float],
        started: float,
    ) -> NavigationDecision:
        sector = perception.sectors.for_direction(ACTION_DIRECTION[action])
        return NavigationDecision(
            action=action,
            confidence=self._decision_confidence(perception, sector),
            reason=reason,
            should_replan=action is not NavigationAction.FORWARD,
            candidate_scores=scores,
            previous_action=self.previous_action,
            latency_ms=(perf_counter() - started) * 1000,
        )

    def _choose_detour_side(self, perception: PerceptionState) -> Direction | None:
        assert perception.target is not None
        supported = [
            direction
            for direction in (Direction.LEFT, Direction.RIGHT)
            if self._supports_movement(perception.sectors.for_direction(direction))
        ]
        if not supported:
            return None
        if perception.target.direction in supported:
            return perception.target.direction
        return max(
            supported,
            key=lambda direction: (
                perception.sectors.for_direction(direction).confidence,
                direction is Direction.RIGHT,
            ),
        )

    def _supports_movement(self, sector: SectorObservation) -> bool:
        return sector.status is SectorStatus.OPEN

    @staticmethod
    def _is_blocked(sector: SectorObservation) -> bool:
        return sector.status is SectorStatus.BLOCKED

    def _score_candidates(self, perception: PerceptionState) -> dict[NavigationAction, float]:
        assert perception.target is not None
        scores: dict[NavigationAction, float] = {}
        for action, direction in ACTION_DIRECTION.items():
            sector = perception.sectors.for_direction(direction)
            score = self._alignment_score(perception.target.direction, direction)
            if sector.status is SectorStatus.BLOCKED:
                score -= self.config.blocked_penalty
            elif sector.status is SectorStatus.OPEN:
                score += self.config.open_base_score
                score += sector.confidence * self.config.open_confidence_weight
            else:
                score -= self.config.uncertainty_penalty
                # Alignment alone must never authorize movement through an
                # uncertain camera region.
                score = min(score, -0.001)

            if self._is_opposite_turn(action, self.previous_action):
                score -= self.config.direction_switch_penalty
            scores[action] = round(score, 3)

        scores[NavigationAction.HOLD] = 0.0
        scores[NavigationAction.REACQUIRE] = -2.0
        return scores

    def _alignment_score(self, target: Direction, candidate: Direction) -> float:
        weight = self.config.target_alignment_weight
        if target is candidate:
            return weight
        if target is Direction.CENTER:
            return weight * 0.25
        if candidate is Direction.CENTER:
            return weight * 0.125
        return -weight * 0.5

    @staticmethod
    def _is_opposite_turn(
        action: NavigationAction,
        previous: NavigationAction | None,
    ) -> bool:
        return (action, previous) in {
            (NavigationAction.TURN_LEFT, NavigationAction.TURN_RIGHT),
            (NavigationAction.TURN_RIGHT, NavigationAction.TURN_LEFT),
        }

    @staticmethod
    def _decision_confidence(
        perception: PerceptionState,
        sector: SectorObservation | None,
    ) -> float:
        values = [perception.scene_confidence]
        if perception.target:
            values.append(perception.target.confidence)
        if sector:
            values.append(sector.confidence)
        return round(min(values), 3)

    def _nonmovement_decision(
        self,
        action: NavigationAction,
        perception: PerceptionState,
        reason: str,
        started: float,
    ) -> NavigationDecision:
        confidence = max(0, min(1, 1 - perception.scene_confidence))
        return NavigationDecision(
            action=action,
            confidence=round(confidence, 3),
            reason=reason,
            should_replan=True,
            candidate_scores={action: 0.0},
            previous_action=self.previous_action,
            latency_ms=(perf_counter() - started) * 1000,
        )

    @staticmethod
    def _reason(
        perception: PerceptionState,
        action: NavigationAction,
        sector: SectorObservation | None,
    ) -> str:
        assert perception.target is not None
        center = perception.sectors.center
        if action is NavigationAction.FORWARD:
            return "Target is centered and the center region is observed open."
        if action is NavigationAction.TURN_LEFT:
            if center.status is SectorStatus.BLOCKED:
                return "Center is blocked; the left region is observed open."
            return "Target is left and the left region is observed open."
        if action is NavigationAction.TURN_RIGHT:
            if center.status is SectorStatus.BLOCKED:
                return "Center is blocked; the right region is observed open."
            return "Target is right and the right region is observed open."
        if sector is None or sector.status is SectorStatus.UNCERTAIN:
            return "No observed open region supports movement."
        return "Holding because no movement candidate is sufficiently supported."


def format_debug(perception: PerceptionState, decision: NavigationDecision) -> str:
    target = perception.target
    target_line = (
        f"{target.label} -> {target.direction.value} ({target.confidence:.0%})"
        if target and target.visible
        else "not visible"
    )
    obstacles = "\n".join(
        f"{item.label} -> {item.direction.value} ({item.confidence:.0%})"
        for item in perception.obstacles
    ) or "none"
    scores = "\n".join(
        f"{action.value:<12} {score:>6.1f}"
        for action, score in decision.candidate_scores.items()
    )
    return f"""--------------------------------
GUIDESIGHT PERCEPTION

Target:
{target_line}

LEFT:   {perception.sectors.left.status.value} ({perception.sectors.left.confidence:.0%})
CENTER: {perception.sectors.center.status.value} ({perception.sectors.center.confidence:.0%})
RIGHT:  {perception.sectors.right.status.value} ({perception.sectors.right.confidence:.0%})

Obstacles:
{obstacles}

--------------------------------
DECISION ENGINE

Previous:
{decision.previous_action.value if decision.previous_action else "NONE"}

Candidates:
{scores}

Selected:
{decision.action.value}

Decision confidence:
{decision.confidence:.0%}

Reason:
{decision.reason}

Decision latency:
{decision.latency_ms:.3f} ms
--------------------------------"""
