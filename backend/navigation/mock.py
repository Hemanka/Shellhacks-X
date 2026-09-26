from __future__ import annotations

from time import time

from .navigator import CameraRelativeNavigator
from .types import (
    Direction,
    NavigationAction,
    ObstacleObservation,
    PerceptionState,
    SectorObservation,
    SectorObservations,
    SectorStatus,
    TargetObservation,
)


def sector(status: SectorStatus, confidence: float = 0.9) -> SectorObservation:
    return SectorObservation(status=status, confidence=confidence)


def perception(
    target_direction: Direction | None,
    left: SectorStatus,
    center: SectorStatus,
    right: SectorStatus,
    *,
    scene_confidence: float = 0.9,
    target_confidence: float = 0.9,
    obstacles: tuple[ObstacleObservation, ...] = (),
) -> PerceptionState:
    target = (
        TargetObservation(True, "exit door", target_direction, target_confidence)
        if target_direction is not None
        else None
    )
    return PerceptionState(
        timestamp=time(),
        target=target,
        sectors=SectorObservations(
            left=sector(left),
            center=sector(center),
            right=sector(right),
        ),
        obstacles=obstacles,
        scene_confidence=scene_confidence,
    )


CHAIR_CENTER = ObstacleObservation("chair", Direction.CENTER, 0.95)


def mock_scenarios() -> dict[str, PerceptionState]:
    return {
        "open_center": perception(
            Direction.CENTER,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        ),
        "right_around_chair": perception(
            Direction.RIGHT,
            SectorStatus.OPEN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
            obstacles=(CHAIR_CENTER,),
        ),
        "left_around_block": perception(
            Direction.LEFT,
            SectorStatus.OPEN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
        ),
        "right_only_open": perception(
            Direction.CENTER,
            SectorStatus.UNCERTAIN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
        ),
        "no_supported_turn": perception(
            Direction.CENTER,
            SectorStatus.UNCERTAIN,
            SectorStatus.BLOCKED,
            SectorStatus.UNCERTAIN,
        ),
        "low_scene_confidence": perception(
            Direction.CENTER,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            scene_confidence=0.3,
        ),
        "target_missing": perception(
            None,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        ),
    }


def dynamic_obstacle_sequence() -> tuple[PerceptionState, PerceptionState]:
    return (
        mock_scenarios()["open_center"],
        perception(
            Direction.CENTER,
            SectorStatus.OPEN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
            obstacles=(CHAIR_CENTER,),
        ),
    )


def main() -> None:
    navigator = CameraRelativeNavigator(debug=True)
    decision = navigator.decide(mock_scenarios()["right_around_chair"])
    if decision.action is not NavigationAction.TURN_RIGHT:
        raise SystemExit(f"Expected TURN_RIGHT, received {decision.action.value}")


if __name__ == "__main__":
    main()
