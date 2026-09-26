from __future__ import annotations

from time import time
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .navigation.types import (
    Direction,
    ObstacleObservation,
    PerceptionState,
    SectorObservation,
    SectorObservations,
    SectorStatus,
    TargetObservation,
)


GEMINI_PERCEPTION_PROMPT = """You are the visual perception component of an experimental
camera-relative navigation system.

Analyze the provided image. The requested navigation target is: {target!r}.

Identify the requested navigation target if visible. Divide the forward camera
view into LEFT, CENTER, and RIGHT regions. For each region determine whether an
obvious physical obstacle appears to block movement through that visible region.

Search the entire full-resolution frame for the requested target, including
small or distant instances. Do not require the target to be close to the camera.
Use the target's visual center to assign LEFT, CENTER, RIGHT, or UNKNOWN. Do not
substitute a visually similar object when the requested target is uncertain.

Return OPEN only when the image provides reasonable visual evidence that no
obvious blocking obstacle occupies the region. Return BLOCKED when an obvious
obstacle occupies the visible travel corridor in that region. Return UNCERTAIN
when perspective, blur, occlusion, lighting, or image coverage does not provide
enough information.

Do not infer precise distances. Do not claim that a route is safe. Do not
provide navigation instructions. Do not decide which direction the user should
move. Only describe what the camera appears to show.

Return only structured JSON matching the required schema."""


GEMINI_PERCEPTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "target": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "visible": {"type": "boolean"},
                "label": {"type": "string"},
                "direction": {"type": "string", "enum": [item.value for item in Direction]},
                "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["visible", "label", "direction", "confidence"],
        },
        "sectors": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                name: {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": [item.value for item in SectorStatus],
                        },
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                    },
                    "required": ["status", "confidence"],
                }
                for name in ("left", "center", "right")
            },
            "required": ["left", "center", "right"],
        },
        "obstacles": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "label": {"type": "string"},
                    "direction": {"type": "string", "enum": [item.value for item in Direction]},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["label", "direction", "confidence"],
            },
        },
        "sceneConfidence": {"type": "number", "minimum": 0, "maximum": 1},
    },
    "required": ["target", "sectors", "obstacles", "sceneConfidence"],
}


class _GeminiSector(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: SectorStatus
    confidence: float = Field(ge=0, le=1)


class _GeminiSectors(BaseModel):
    model_config = ConfigDict(extra="forbid")
    left: _GeminiSector
    center: _GeminiSector
    right: _GeminiSector


class _GeminiTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    visible: bool
    label: str
    direction: Direction
    confidence: float = Field(ge=0, le=1)


class _GeminiObstacle(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: str
    direction: Direction
    confidence: float = Field(ge=0, le=1)


class _GeminiPerception(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: _GeminiTarget
    sectors: _GeminiSectors
    obstacles: list[_GeminiObstacle] = Field(default_factory=list)
    scene_confidence: float = Field(alias="sceneConfidence", ge=0, le=1)


def uncertain_perception(target_label: str, *, timestamp: float | None = None) -> PerceptionState:
    uncertain = SectorObservation(SectorStatus.UNCERTAIN, 0)
    return PerceptionState(
        timestamp=timestamp if timestamp is not None else time(),
        target=TargetObservation(False, target_label, Direction.UNKNOWN, 0),
        sectors=SectorObservations(left=uncertain, center=uncertain, right=uncertain),
        obstacles=(),
        scene_confidence=0,
    )


def parse_gemini_perception(
    raw: object,
    requested_target: str,
    *,
    timestamp: float | None = None,
) -> tuple[PerceptionState, str | None]:
    """Validate Gemini data, returning uncertainty rather than invented fields."""
    try:
        parsed = _GeminiPerception.model_validate(raw)
    except (ValidationError, TypeError, ValueError) as exc:
        return uncertain_perception(requested_target, timestamp=timestamp), str(exc)

    target = parsed.target
    if not target.visible:
        target = target.model_copy(update={"direction": Direction.UNKNOWN})
    state = PerceptionState(
        timestamp=timestamp if timestamp is not None else time(),
        target=TargetObservation(
            visible=target.visible,
            label=target.label or requested_target,
            direction=target.direction,
            confidence=target.confidence,
        ),
        sectors=SectorObservations(
            left=SectorObservation(parsed.sectors.left.status, parsed.sectors.left.confidence),
            center=SectorObservation(parsed.sectors.center.status, parsed.sectors.center.confidence),
            right=SectorObservation(parsed.sectors.right.status, parsed.sectors.right.confidence),
        ),
        obstacles=tuple(
            ObstacleObservation(item.label, item.direction, item.confidence)
            for item in parsed.obstacles
        ),
        scene_confidence=parsed.scene_confidence,
    )
    return state, None


def perception_to_dict(perception: PerceptionState) -> dict[str, Any]:
    target = perception.target
    return {
        "timestamp": perception.timestamp,
        "target": None if target is None else {
            "visible": target.visible,
            "label": target.label,
            "direction": target.direction.value,
            "confidence": target.confidence,
        },
        "sectors": {
            name: {
                "status": getattr(perception.sectors, name).status.value,
                "confidence": getattr(perception.sectors, name).confidence,
            }
            for name in ("left", "center", "right")
        },
        "obstacles": [
            {
                "label": item.label,
                "direction": item.direction.value,
                "confidence": item.confidence,
            }
            for item in perception.obstacles
        ],
        "sceneConfidence": perception.scene_confidence,
    }
