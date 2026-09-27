import base64
import json
import os
import unittest
from unittest.mock import Mock, patch

import requests

from backend.main import FrameRequest, analyze_frame
from backend.navigation.types import Direction, SectorStatus
from backend.perception import parse_gemini_perception


VALID_SCENE = {
    "target": {
        "visible": True,
        "label": "exit door",
        "direction": "RIGHT",
        "confidence": 0.91,
        "bbox": [0.62, 0.25, 0.88, 0.85],
    },
    "sectors": {
        "left": {"status": "OPEN", "confidence": 0.83},
        "center": {"status": "BLOCKED", "confidence": 0.94},
        "right": {"status": "OPEN", "confidence": 0.87},
    },
    "obstacles": [
        {"label": "chair", "direction": "CENTER", "confidence": 0.95}
    ],
    "sceneConfidence": 0.9,
}


class GeminiPerceptionValidationTests(unittest.TestCase):
    def test_valid_scene_maps_to_central_navigation_types(self) -> None:
        perception, error = parse_gemini_perception(VALID_SCENE, "exit door", timestamp=1)
        self.assertIsNone(error)
        self.assertEqual(perception.target.direction, Direction.RIGHT)
        self.assertEqual(perception.target.bbox, (0.62, 0.25, 0.88, 0.85))
        self.assertEqual(perception.sectors.center.status, SectorStatus.BLOCKED)
        self.assertEqual(perception.obstacles[0].label, "chair")

    def test_invalid_enum_returns_fully_uncertain_perception(self) -> None:
        invalid = json.loads(json.dumps(VALID_SCENE))
        invalid["sectors"]["center"]["status"] = "SAFE_TO_WALK"
        perception, error = parse_gemini_perception(invalid, "exit door", timestamp=1)
        self.assertIsNotNone(error)
        self.assertFalse(perception.target.visible)
        self.assertEqual(perception.sectors.center.status, SectorStatus.UNCERTAIN)
        self.assertEqual(perception.scene_confidence, 0)

    def test_missing_fields_return_uncertainty_without_invention(self) -> None:
        perception, error = parse_gemini_perception(
            {"target": VALID_SCENE["target"]},
            "exit door",
            timestamp=1,
        )
        self.assertIsNotNone(error)
        self.assertEqual(perception.obstacles, ())
        self.assertEqual(perception.target.direction, Direction.UNKNOWN)


class AnalyzeFrameIntegrationTests(unittest.TestCase):
    def test_structured_scene_drives_turn_right_decision(self) -> None:
        upstream = Mock()
        upstream.raise_for_status.return_value = None
        upstream.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": json.dumps(VALID_SCENE)}]}}]
        }
        payload = FrameRequest(
            image_base64=base64.b64encode(b"test-image").decode("ascii"),
            target_object="integration exit door",
        )
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "DEMO_MODE": "false"}), patch(
            "backend.main.requests.post", return_value=upstream
        ):
            result = analyze_frame(payload)

        self.assertEqual(result["decision"]["action"], "TURN_RIGHT")
        self.assertEqual(result["decision"]["voiceInstruction"], "Turn slightly right.")
        self.assertEqual(result["perception"]["obstacles"][0]["label"], "chair")
        self.assertEqual(result["source"], "gemini")

    def test_malformed_gemini_json_reacquires_without_crashing(self) -> None:
        upstream = Mock()
        upstream.raise_for_status.return_value = None
        upstream.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": "not-json"}]}}]
        }
        payload = FrameRequest(
            image_base64=base64.b64encode(b"test-image").decode("ascii"),
            target_object="malformed output target",
        )
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "DEMO_MODE": "false"}), patch(
            "backend.main.requests.post", return_value=upstream
        ):
            result = analyze_frame(payload)

        self.assertEqual(result["decision"]["action"], "REACQUIRE")
        self.assertEqual(result["source"], "fallback")
        self.assertIn("perception_error", result)

    def test_rate_limited_primary_model_uses_fallback_model(self) -> None:
        limited = Mock(status_code=429)
        fallback = Mock(status_code=200)
        fallback.raise_for_status.return_value = None
        fallback.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": json.dumps(VALID_SCENE)}]}}]
        }
        payload = FrameRequest(
            image_base64=base64.b64encode(b"test-image").decode("ascii"),
            target_object="fallback exit door",
        )
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "DEMO_MODE": "false"}), patch(
            "backend.main.requests.post", side_effect=[limited, fallback]
        ):
            result = analyze_frame(payload)

        self.assertEqual(result["decision"]["action"], "TURN_RIGHT")
        self.assertEqual(result["model"], "gemini-3.5-flash-lite")
        self.assertFalse(result["rateLimited"])

    def test_all_models_rate_limited_holds_and_returns_cooldown(self) -> None:
        limited = Mock(status_code=429)
        limited.headers = {}
        limited.json.return_value = {
            "error": {
                "message": "Quota exceeded. Please retry in 35s.",
                "details": [],
            }
        }
        limited.raise_for_status.side_effect = requests.HTTPError(response=limited)
        payload = FrameRequest(
            image_base64=base64.b64encode(b"test-image").decode("ascii"),
            target_object="rate limited target",
        )
        with patch.dict(os.environ, {"GEMINI_API_KEY": "test-key", "DEMO_MODE": "false"}), patch(
            "backend.main.requests.post", side_effect=[Mock(status_code=429), limited]
        ):
            result = analyze_frame(payload)

        self.assertEqual(result["decision"]["action"], "HOLD")
        self.assertEqual(result["source"], "rate_limit")
        self.assertTrue(result["rateLimited"])
        self.assertEqual(result["retryAfterMs"], 35_000)


if __name__ == "__main__":
    unittest.main()
