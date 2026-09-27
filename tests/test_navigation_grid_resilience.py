import unittest
from io import BytesIO
from unittest.mock import patch

from PIL import Image

from backend.main import navigation_grid
from backend.navigation.types import (
    Direction,
    PerceptionState,
    SectorObservation,
    SectorObservations,
    SectorStatus,
    TargetObservation,
)


class NavigationGridResilienceTests(unittest.TestCase):
    def test_model_import_failure_does_not_escape_navigation_grid(self) -> None:
        target = TargetObservation(
            True, "door", Direction.CENTER, 0.9, (0.1, 0.1, 0.2, 0.2)
        )
        uncertain = SectorObservation(SectorStatus.UNCERTAIN, 0)
        perception = PerceptionState(
            timestamp=0,
            target=target,
            sectors=SectorObservations(uncertain, uncertain, uncertain),
        )
        with patch(
            "backend.main.traversability_segmenter.segment",
            side_effect=ImportError("transformers import failed"),
        ):
            image_bytes = BytesIO()
            Image.new("RGB", (2, 2), "white").save(image_bytes, format="PNG")
            self.assertIsNone(navigation_grid(image_bytes.getvalue(), perception))


if __name__ == "__main__":
    unittest.main()