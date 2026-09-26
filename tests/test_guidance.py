from dataclasses import replace
import unittest

from backend.navigation.guidance import guidance_for_step
from backend.navigation.mock import mock_scenarios, perception
from backend.navigation.navigator import CameraRelativeNavigator
from backend.navigation.types import Direction, NavigationAction, SectorStatus


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.scenes = mock_scenarios()

    def guidance(self, scene):
        return guidance_for_step(CameraRelativeNavigator().decide(scene), scene)

    def test_forward_is_one_bounded_action(self):
        result = self.guidance(self.scenes["open_center"])
        self.assertEqual(result.instruction, "Take one small step forward, then stop.")
        self.assertEqual(result.spoken_text, result.instruction)

    def test_both_detour_directions_warn_before_turning(self):
        for name, side in [("right_around_chair", "right"), ("left_around_block", "left")]:
            with self.subTest(side=side):
                result = self.guidance(self.scenes[name])
                self.assertEqual(result.spoken_text, f"Obstacle ahead. Turn slightly {side}, then stop.")
                self.assertTrue(result.announcement_key.endswith(":detour"))

    def test_alignment_does_not_invent_an_obstacle(self):
        scene = perception(Direction.LEFT, SectorStatus.OPEN, SectorStatus.OPEN, SectorStatus.OPEN)
        result = self.guidance(scene)
        self.assertEqual(result.context, "The target is to your left.")
        self.assertEqual(result.spoken_text, "Turn slightly left, then stop.")

    def test_blocked_route_gives_stop_instruction(self):
        result = self.guidance(self.scenes["no_supported_turn"])
        self.assertEqual(result.instruction, "Stop. Hold your position.")
        self.assertIn("blocking", result.context)

    def test_missing_target_requests_stationary_recheck(self):
        result = self.guidance(self.scenes["target_missing"])
        self.assertIn("slowly pan your phone", result.spoken_text)
        self.assertIn("Stay in place", result.spoken_text)
        self.assertIn("Keep looking around", result.context)

    def test_missing_target_and_blocked_regions_still_request_camera_scan(self):
        scene = perception(None, SectorStatus.BLOCKED, SectorStatus.BLOCKED, SectorStatus.BLOCKED)
        result = self.guidance(scene)
        self.assertIn("Obstacles are nearby", result.spoken_text)
        self.assertIn("slowly pan your phone", result.spoken_text)
        self.assertEqual(result.announcement_key, "search:blocked")

    def test_search_ends_when_target_is_spotted(self):
        navigator = CameraRelativeNavigator()
        missing = self.scenes["target_missing"]
        found = self.scenes["open_center"]
        self.assertTrue(guidance_for_step(navigator.decide(missing), missing).announcement_key.startswith("search:"))
        self.assertEqual(guidance_for_step(navigator.decide(found), found).instruction, "Take one small step forward, then stop.")

    def test_history_does_not_claim_target_is_currently_visible(self):
        navigator = CameraRelativeNavigator()
        first = perception(Direction.LEFT, SectorStatus.OPEN, SectorStatus.OPEN, SectorStatus.OPEN)
        navigator.decide(first)
        scene = self.scenes["target_missing"]
        result = guidance_for_step(navigator.decide(scene), scene)
        self.assertNotIn("target is", result.context)

    def test_live_sequence_changes_instruction_when_obstacle_appears(self):
        navigator = CameraRelativeNavigator()
        instructions = []
        for scene in [self.scenes["open_center"], self.scenes["right_around_chair"], self.scenes["no_supported_turn"]]:
            instructions.append(guidance_for_step(navigator.decide(scene), scene).spoken_text)
        self.assertEqual(instructions, [
            "Take one small step forward, then stop.",
            "Obstacle ahead. Turn slightly right, then stop.",
            "Stop. Hold your position.",
        ])

    def test_confidence_or_reason_jitter_does_not_change_announcement_key(self):
        scene = self.scenes["right_around_chair"]
        decision = CameraRelativeNavigator().decide(scene)
        original = guidance_for_step(decision, scene)
        changed = guidance_for_step(replace(decision, confidence=.73, reason="Different diagnostic wording"), scene)
        self.assertEqual(original.announcement_key, changed.announcement_key)

    def test_visible_target_does_not_imply_arrival(self):
        scene = self.scenes["open_center"]
        decision = CameraRelativeNavigator().decide(scene)
        self.assertNotIn("reached", guidance_for_step(decision, scene).spoken_text)
        arrived = guidance_for_step(replace(decision, action=NavigationAction.ARRIVED), scene)
        self.assertEqual(arrived.instruction, "Stop. You have reached your destination.")

    def test_payload_contains_display_and_speech_fields(self):
        result = self.guidance(self.scenes["open_center"]).to_dict()
        self.assertEqual(set(result), {"instruction", "context", "spokenText", "announcementKey"})


if __name__ == "__main__":
    unittest.main()
