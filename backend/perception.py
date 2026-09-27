from __future__ import annotations

from time import time
from typing import Any, Literal
from pydantic import model_validator

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

The target request names one concrete item, optionally with visual attributes
such as color, pattern, size, or material (for example, "red cup" or "black
hoodie"). Match that item and its attributes. Do not treat rooms, landmarks,
directions, actions, people, or abstract goals as target objects.

The request names what to search for, not what is present. Never assume it exists
in the image. A blank or featureless view must return visible=false and uncertain
access. Identify the requested navigation target only if visibly supported. Divide the forward camera
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

Distinguish the target footprint from access to it. A target on the floor is
occupied space, not a separate barrier to itself. Assess whether OTHER objects
block the approach corridor or reach area. Do not clear occupancy by label match.
Report normalized bounding boxes as [left, top, right, bottom], or null.
Use easily_reachable only when visual evidence supports a comfortable grasp
from the current position with a relaxed arm movement, without another step,
leaning the torso, lunging, stretching, or reaching across a deep surface. Require
room for the hand to approach and grasp the item, not merely touch it at maximum
extension. A hand need not be visible. Use likely_reachable for a plausible but
marginal or unconfirmed reach; this does NOT qualify for pickup. Describe the
specific visual evidence for an easy reach; do not invent metric distances. Seeing an item clearly, a large bounding box, or approaching its support
does not establish this. If several steps or any further approach are needed,
use needs_approach. If distance cannot be inferred, use uncertain.
Assess support location, pickup suitability, coarse reachability and supporting
visible evidence. A hand need not be visible. Image size or bottom-of-frame
position ALONE never proves reachability or proximity. If the context does not
support an assessment, use uncertain. Doors and other non-pickup destinations
are not pickup objects. Name each obstacle using a supported category; use
'obstacle' if identity is unclear. Report whether it appears close and intrudes
into the intended approach or reach area; do not invent measured distances.
Object identity confidence is NOT proximity confidence. Report proximityConfidence
separately; a recognizable distant chair can have high identity confidence and
not_close proximity. Only use appears_close with strong scene evidence of an
immediate collision/reach obstruction. Perspective, visible floor gap, relative
occlusion and scene context matter; image size alone is insufficient. If unsure,
use uncertain and low proximityConfidence, never turn uncertainty into close.
Any object or surface holding the target (table, counter, shelf, chair, cabinet,
trash can, or another support) has
relationship=target_support, not separate. Describe its real approach/reach
intrusion: the support stops walking at the destination but does not automatically
block reaching the item on its surface. Do not recommend walking through it.
Assess the open floor BEFORE the support separately from the space for reaching
the target. access.approach describes space for the NEXT small step toward a
reachable stopping position in front of the support, not a path through the
support or all the way to the target's image coordinates. Report clear when that
next step has visible open floor and the support is still distant; its occupied
endpoint alone does not make the approach blocked. Report blocked when the
support is immediately in the way of that step. Report uncertain when this
cannot be assessed. Reassess reachability as the user approaches. Items too high,
behind glass, or behind other objects must not be called reachable merely because
their support is near. A separate obstruction still blocks access.
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


class _BoxModel(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bbox: tuple[float, float, float, float] | None = None

    @model_validator(mode="after")
    def valid_box(self):
        if self.bbox is not None:
            l, t, r, b = self.bbox
            if not (0 <= l < r <= 1 and 0 <= t < b <= 1):
                raise ValueError("bbox must be normalized left, top, right, bottom")
        return self


class _GeminiTarget(_BoxModel):
    visible: bool
    label: str = Field(max_length=100)
    direction: Direction
    confidence: float = Field(ge=0, le=1)
    support: Literal["floor", "table", "shelf", "other", "unknown"] = "unknown"
    pickupSuitable: bool = False


class _GeminiObstacle(_BoxModel):
    label: str = Field(max_length=100)
    direction: Direction
    confidence: float = Field(ge=0, le=1)
    relationship: Literal["target_itself", "target_support", "separate", "uncertain"] = "uncertain"
    proximityConfidence: float = Field(default=0, ge=0, le=1)
    proximity: Literal["appears_close", "not_close", "uncertain"] = "uncertain"
    intrusion: Literal["approach", "reach", "both", "none", "uncertain"] = "uncertain"
    evidence: str = Field(default="", max_length=300)


class _Access(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approach: Literal["clear", "blocked", "uncertain"] = "uncertain"
    reach: Literal["clear", "blocked", "uncertain"] = "uncertain"
    reachability: Literal["easily_reachable", "likely_reachable", "needs_approach", "uncertain"] = "uncertain"
    evidence: str = Field(default="", max_length=300)


class _GeminiPerception(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: _GeminiTarget
    sectors: _GeminiSectors
    obstacles: list[_GeminiObstacle] = Field(default_factory=list, max_length=12)
    scene_confidence: float = Field(alias="sceneConfidence", ge=0, le=1)
    access: _Access = Field(default_factory=_Access)


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
        details=parsed.model_dump(mode="json", by_alias=True),
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
        **perception.details,
    }

# Require the new observations from Gemini, while accepting legacy fixtures as unknown.
_box_schema = {"anyOf": [{"type": "array", "items": {"type": "number", "minimum": 0, "maximum": 1}, "minItems": 4, "maxItems": 4}, {"type": "null"}]}
for _name, _model in [("target", _GeminiTarget), ("obstacles", _GeminiObstacle)]:
    _schema = GEMINI_PERCEPTION_SCHEMA["properties"][_name]
    if _name == "obstacles":
        _schema = _schema["items"]
        GEMINI_PERCEPTION_SCHEMA["properties"][_name]["maxItems"] = 12
    _schema["properties"]["bbox"] = _box_schema
    for _field, _definition in _model.model_json_schema()["properties"].items():
        if _field not in _schema["properties"]:
            _schema["properties"][_field] = {k: v for k, v in _definition.items() if k not in ("default", "title")}
    _schema["required"] = list(_schema["properties"])
GEMINI_PERCEPTION_SCHEMA["properties"]["access"] = {
    "type": "object", "additionalProperties": False,
    "properties": {k: {a: b for a, b in v.items() if a not in ("default", "title")} for k, v in _Access.model_json_schema()["properties"].items()},
    "required": list(_Access.model_fields),
}
GEMINI_PERCEPTION_SCHEMA["required"].append("access")
