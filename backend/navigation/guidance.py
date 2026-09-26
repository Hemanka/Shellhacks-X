"""Convert the selected local navigation step into concise user instructions.

These are camera-relative steps, not a measured route or a waypoint tracker.
Formatting is deterministic and adds no model request to the live loop.
"""

from dataclasses import dataclass

from .types import Direction, NavigationAction, NavigationDecision, PerceptionState, SectorStatus


@dataclass(frozen=True, slots=True)
class NavigationGuidance:
    instruction: str
    context: str
    spoken_text: str
    announcement_key: str

    def to_dict(self) -> dict[str, str]:
        return {
            "instruction": self.instruction,
            "context": self.context,
            "spokenText": self.spoken_text,
            "announcementKey": self.announcement_key,
        }


def guidance_for_step(
    decision: NavigationDecision, perception: PerceptionState
) -> NavigationGuidance:
    """Describe only the current decision; never invent distances or later steps."""
    action = decision.action
    center_blocked = perception.sectors.center.status is SectorStatus.BLOCKED
    target_visible = bool(perception.target and perception.target.visible)

    if not target_visible and action is not NavigationAction.ARRIVED:
        # Searching changes the camera view, not the user's walking position.
        # Even a remembered direction must not turn into a walking instruction.
        blocked = any(
            sector.status is SectorStatus.BLOCKED
            for sector in (perception.sectors.left, perception.sectors.center, perception.sectors.right)
        )
        instruction = "Stay in place and slowly pan your phone left and right to scan the room."
        context = "I haven't spotted the target yet. Keep looking around."
        warning = "Obstacles are nearby. " if blocked else ""
        return NavigationGuidance(
            instruction=instruction,
            context=context,
            spoken_text=f"{warning}{context} {instruction}",
            announcement_key="search:blocked" if blocked else "search:target_missing",
        )
    if action is NavigationAction.FORWARD:
        instruction = "Take one small step forward, then stop."
        context = "I'll check the next step from the new view."
        mode = "step"
    elif action in (NavigationAction.TURN_LEFT, NavigationAction.TURN_RIGHT):
        side = "left" if action is NavigationAction.TURN_LEFT else "right"
        instruction = f"Turn slightly {side}, then stop."
        if center_blocked:
            context = "There is an obstacle ahead."
            mode = "detour"
        else:
            # A selected turn may use recent target history rather than a
            # currently visible target, so do not claim it is in view.
            direction = Direction.LEFT if side == "left" else Direction.RIGHT
            if target_visible and perception.target.direction is direction:
                context = f"The target is to your {side}."
            else:
                context = "I'll check the route again after you turn."
            mode = "align"
    elif action is NavigationAction.HOLD:
        instruction = "Stop. Hold your position."
        blocked = any(
            sector.status is SectorStatus.BLOCKED
            for sector in (perception.sectors.left, perception.sectors.center, perception.sectors.right)
        )
        context = "An obstacle is blocking the route." if blocked else "I can't confirm the next step."
        mode = "blocked" if blocked else "uncertain"
    elif action is NavigationAction.REACQUIRE:
        instruction = "Stop. Hold still while I check again."
        context = "I can't see the target." if not target_visible else "The route is unclear."
        mode = "target_missing" if not target_visible else "uncertain"
    elif action is NavigationAction.ARRIVED:
        # The current navigator does not emit ARRIVED. Only translate that
        # explicit action; target visibility alone never establishes arrival.
        instruction = "Stop. You have reached your destination."
        context = "Navigation complete."
        mode = "arrived"
    else:
        raise ValueError(f"Unsupported navigation action: {action}")

    # Put the obstacle warning before a detour, and keep the spoken cue short.
    spoken = f"Obstacle ahead. {instruction}" if mode == "detour" else instruction
    return NavigationGuidance(
        instruction=instruction,
        context=context,
        spoken_text=spoken,
        announcement_key=f"{action.value}:{mode}",
    )
