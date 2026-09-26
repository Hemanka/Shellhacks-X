from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class Direction(str, Enum):
    LEFT = "LEFT"
    CENTER = "CENTER"
    RIGHT = "RIGHT"
    UNKNOWN = "UNKNOWN"


class SectorStatus(str, Enum):
    OPEN = "OPEN"
    BLOCKED = "BLOCKED"
    UNCERTAIN = "UNCERTAIN"


class NavigationAction(str, Enum):
    FORWARD = "FORWARD"
    TURN_LEFT = "TURN_LEFT"
    TURN_RIGHT = "TURN_RIGHT"
    HOLD = "HOLD"
    REACQUIRE = "REACQUIRE"
    ARRIVED = "ARRIVED"


def _check_confidence(name: str, confidence: float) -> None:
    if not 0 <= confidence <= 1:
        raise ValueError(f"{name} must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class SectorObservation:
    status: SectorStatus
    confidence: float

    def __post_init__(self) -> None:
        _check_confidence("sector confidence", self.confidence)


@dataclass(frozen=True, slots=True)
class SectorObservations:
    left: SectorObservation
    center: SectorObservation
    right: SectorObservation

    def for_direction(self, direction: Direction) -> SectorObservation:
        if direction is Direction.LEFT:
            return self.left
        if direction is Direction.CENTER:
            return self.center
        if direction is Direction.RIGHT:
            return self.right
        return SectorObservation(SectorStatus.UNCERTAIN, 0)


@dataclass(frozen=True, slots=True)
class TargetObservation:
    visible: bool
    label: str
    direction: Direction
    confidence: float

    def __post_init__(self) -> None:
        _check_confidence("target confidence", self.confidence)


@dataclass(frozen=True, slots=True)
class ObstacleObservation:
    label: str
    direction: Direction
    confidence: float

    def __post_init__(self) -> None:
        _check_confidence("obstacle confidence", self.confidence)


@dataclass(frozen=True, slots=True)
class PerceptionState:
    timestamp: float
    target: TargetObservation | None
    sectors: SectorObservations
    obstacles: tuple[ObstacleObservation, ...] = ()
    scene_confidence: float = 0

    def __post_init__(self) -> None:
        _check_confidence("scene confidence", self.scene_confidence)


@dataclass(frozen=True, slots=True)
class NavigationDecision:
    action: NavigationAction
    confidence: float
    reason: str
    should_replan: bool
    candidate_scores: dict[NavigationAction, float] = field(default_factory=dict)
    previous_action: NavigationAction | None = None
    latency_ms: float = 0

    def __post_init__(self) -> None:
        _check_confidence("decision confidence", self.confidence)
