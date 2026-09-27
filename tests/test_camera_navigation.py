from dataclasses import replace
import unittest

from backend.navigation.mock import dynamic_obstacle_sequence, mock_scenarios, perception
from backend.navigation.navigator import CameraRelativeNavigator
from backend.navigation.types import Direction, NavigationAction, SectorObservation, SectorStatus


class CameraRelativeNavigationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scenarios = mock_scenarios()

    def decide(self, scenario: str) -> NavigationAction:
        return CameraRelativeNavigator().decide(self.scenarios[scenario]).action

    def test_center_target_with_open_center_moves_forward(self) -> None:
        self.assertEqual(self.decide("open_center"), NavigationAction.FORWARD)

    def test_a_star_grid_selects_next_step_toward_target(self) -> None:
        state = self.scenarios["open_center"]
        grid = [
            [1, 1, 2, 1, 1],
            [1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1],
            [1, 1, -1, 1, 1],
        ]
        decision = CameraRelativeNavigator().decide(state, grid=grid)
        self.assertEqual(decision.action, NavigationAction.FORWARD)

    def test_a_star_grid_selects_horizontal_detour(self) -> None:
        state = self.scenarios["open_center"]
        grid = [
            [1, 1, 1, 1, 2],
            [1, 1, 0, 1, 1],
            [1, 1, 0, 1, 1],
            [1, 1, -1, 1, 1],
        ]
        decision = CameraRelativeNavigator().decide(state, grid=grid)
        self.assertEqual(decision.action, NavigationAction.TURN_RIGHT)

    def test_right_target_turns_right_around_center_chair(self) -> None:
        decision = CameraRelativeNavigator().decide(self.scenarios["right_around_chair"])
        self.assertEqual(decision.action, NavigationAction.TURN_RIGHT)
        self.assertIn("right", decision.reason)

    def test_left_target_turns_left_around_center_block(self) -> None:
        self.assertEqual(self.decide("left_around_block"), NavigationAction.TURN_LEFT)

    def test_center_target_uses_only_observed_open_side(self) -> None:
        self.assertEqual(self.decide("right_only_open"), NavigationAction.TURN_RIGHT)

    def test_uncertain_sides_do_not_support_movement(self) -> None:
        self.assertEqual(self.decide("no_supported_turn"), NavigationAction.HOLD)

    def test_center_open_at_point_55_moves_forward(self) -> None:
        state = self.scenarios["open_center"]
        state = replace(
            state,
            sectors=replace(
                state.sectors,
                center=SectorObservation(SectorStatus.OPEN, 0.55),
            ),
        )
        decision = CameraRelativeNavigator().decide(state)
        self.assertEqual(decision.action, NavigationAction.FORWARD)

    def test_low_scene_confidence_does_not_gate_valid_observation(self) -> None:
        self.assertEqual(self.decide("low_scene_confidence"), NavigationAction.FORWARD)

    def test_missing_target_reacquires_without_history(self) -> None:
        self.assertEqual(self.decide("target_missing"), NavigationAction.REACQUIRE)

    def test_temporarily_missing_target_preserves_recent_direction(self) -> None:
        navigator = CameraRelativeNavigator()
        navigator.decide(self.scenarios["open_center"])
        decision = navigator.decide(self.scenarios["target_missing"])
        self.assertEqual(decision.action, NavigationAction.FORWARD)

    def test_right_open_at_point_52_beats_blocked_center(self) -> None:
        state = perception(
            Direction.RIGHT,
            SectorStatus.UNCERTAIN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
        )
        state = replace(
            state,
            sectors=replace(
                state.sectors,
                center=SectorObservation(SectorStatus.BLOCKED, 0.60),
                right=SectorObservation(SectorStatus.OPEN, 0.52),
            ),
        )
        self.assertEqual(
            CameraRelativeNavigator().decide(state).action,
            NavigationAction.TURN_RIGHT,
        )

    def test_left_open_at_point_58_beats_blocked_center(self) -> None:
        state = perception(
            Direction.LEFT,
            SectorStatus.OPEN,
            SectorStatus.BLOCKED,
            SectorStatus.UNCERTAIN,
        )
        state = replace(
            state,
            sectors=replace(
                state.sectors,
                left=SectorObservation(SectorStatus.OPEN, 0.58),
            ),
        )
        self.assertEqual(
            CameraRelativeNavigator().decide(state).action,
            NavigationAction.TURN_LEFT,
        )

    def test_all_uncertain_reacquires(self) -> None:
        state = perception(
            Direction.CENTER,
            SectorStatus.UNCERTAIN,
            SectorStatus.UNCERTAIN,
            SectorStatus.UNCERTAIN,
        )
        self.assertEqual(
            CameraRelativeNavigator().decide(state).action,
            NavigationAction.REACQUIRE,
        )

    def test_all_blocked_holds(self) -> None:
        state = perception(
            Direction.CENTER,
            SectorStatus.BLOCKED,
            SectorStatus.BLOCKED,
            SectorStatus.BLOCKED,
        )
        self.assertEqual(
            CameraRelativeNavigator().decide(state).action,
            NavigationAction.HOLD,
        )

    def test_target_alignment_beats_higher_open_confidence(self) -> None:
        state = perception(
            Direction.RIGHT,
            SectorStatus.OPEN,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
        )
        state = replace(
            state,
            sectors=replace(
                state.sectors,
                left=SectorObservation(SectorStatus.OPEN, 0.90),
                center=SectorObservation(SectorStatus.BLOCKED, 0.95),
                right=SectorObservation(SectorStatus.OPEN, 0.60),
            ),
        )
        self.assertEqual(
            CameraRelativeNavigator().decide(state).action,
            NavigationAction.TURN_RIGHT,
        )

    def test_one_missing_frame_preserves_right_target_direction(self) -> None:
        navigator = CameraRelativeNavigator()
        visible = perception(
            Direction.RIGHT,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        )
        missing = perception(
            None,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        )
        navigator.decide(visible)
        self.assertEqual(
            navigator.decide(missing).action,
            NavigationAction.TURN_RIGHT,
        )

    def test_dynamic_center_obstacle_changes_forward_to_right(self) -> None:
        navigator = CameraRelativeNavigator()
        clear_frame, blocked_frame = dynamic_obstacle_sequence()
        self.assertEqual(navigator.decide(clear_frame).action, NavigationAction.FORWARD)
        self.assertEqual(navigator.decide(blocked_frame).action, NavigationAction.TURN_RIGHT)

    def test_complete_detour_turns_passes_and_realigns(self) -> None:
        navigator = CameraRelativeNavigator()
        _, blocked_frame = dynamic_obstacle_sequence()
        passing_frame = perception(
            Direction.LEFT,
            SectorStatus.BLOCKED,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        )
        realign_frame = perception(
            Direction.LEFT,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
            SectorStatus.OPEN,
        )

        actions = [
            navigator.decide(blocked_frame).action,
            navigator.decide(passing_frame).action,
            navigator.decide(passing_frame).action,
            navigator.decide(realign_frame).action,
        ]
        self.assertEqual(
            actions,
            [
                NavigationAction.TURN_RIGHT,
                NavigationAction.FORWARD,
                NavigationAction.FORWARD,
                NavigationAction.TURN_LEFT,
            ],
        )


if __name__ == "__main__":
    unittest.main()
