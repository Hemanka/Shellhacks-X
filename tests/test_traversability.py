import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from backend.traversability.debug import (
    load_obstacles,
    overlay_data_url,
    render_debug,
    transparent_overlay,
)
from backend.traversability.mask import (
    ObstacleBox,
    TraversabilityMask,
    fuse_obstacles,
    retain_ground_connected,
)


def candidate_mask(width: int = 10, height: int = 10) -> TraversabilityMask:
    candidate = np.ones((height, width), dtype=np.bool_)
    empty = np.zeros((height, width), dtype=np.bool_)
    return TraversabilityMask(
        width=width,
        height=height,
        candidate_walkable_mask=candidate,
        non_walkable_mask=empty.copy(),
        unknown_mask=empty.copy(),
        blocked_mask=empty.copy(),
        inference_ms=4.2,
    )


class TraversabilityMaskTests(unittest.TestCase):
    def test_floating_candidate_islands_become_disconnected(self) -> None:
        candidate = np.zeros((8, 8), dtype=np.bool_)
        candidate[4:, 1:7] = True
        candidate[1:3, 3:5] = True
        retained = retain_ground_connected(candidate, lower_band_fraction=0.25)
        self.assertTrue(retained[4:, 1:7].all())
        self.assertFalse(retained[1:3, 3:5].any())

    def test_obstacle_overrides_candidate_walkable_pixels(self) -> None:
        result = fuse_obstacles(
            candidate_mask(),
            [ObstacleBox("chair", 0.4, 0.4, 0.6, 0.6)],
            padding=0,
        )
        self.assertTrue(result.blocked_mask[4:6, 4:6].all())
        self.assertFalse(result.candidate_walkable_mask[4:6, 4:6].any())
        self.assertAlmostEqual(sum(result.percentages().values()), 100)

    def test_obstacle_padding_expands_planning_region(self) -> None:
        unpadded = fuse_obstacles(
            candidate_mask(),
            [ObstacleBox("desk", 0.4, 0.4, 0.6, 0.6)],
            padding=0,
        )
        padded = fuse_obstacles(
            candidate_mask(),
            [ObstacleBox("desk", 0.4, 0.4, 0.6, 0.6)],
            padding=0.5,
        )
        self.assertGreater(padded.blocked_mask.sum(), unpadded.blocked_mask.sum())

    def test_obstacle_json_accepts_normalized_bbox(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "obstacles.json"
            path.write_text(
                '{"obstacles":[{"label":"chair","bbox":[0.1,0.2,0.3,0.5]}]}',
                encoding="utf-8",
            )
            obstacles = load_obstacles(path)
        self.assertEqual(obstacles[0].label, "chair")
        self.assertEqual(obstacles[0].bottom, 0.5)

    def test_debug_visualization_has_three_panels(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "walkable-debug.png"
            render_debug(Image.new("RGB", (10, 10), "white"), candidate_mask(), output)
            with Image.open(output) as rendered:
                size = rendered.size
        self.assertEqual(size, (30, 80))

    def test_live_overlay_is_transparent_png_data_url(self) -> None:
        mask = candidate_mask(width=20, height=10)
        overlay = transparent_overlay(mask)
        self.assertEqual(overlay.mode, "RGBA")
        self.assertEqual(overlay.size, (20, 10))
        self.assertGreater(overlay.getpixel((0, 0))[3], 0)
        self.assertTrue(overlay_data_url(mask).startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
