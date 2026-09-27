from __future__ import annotations

from pathlib import Path
from threading import Lock
from time import perf_counter

import numpy as np
from PIL import Image

from .mask import SegmentationConfig, TraversabilityMask, retain_ground_connected


def mark_target_bbox(
    grid: np.ndarray,
    target_bbox: tuple[float, float, float, float],
) -> None:
    """Mark every NVIDIA planning cell covered by Gemini's normalized bbox."""
    left, top, right, bottom = target_bbox
    if any(not 0 <= coordinate <= 1 for coordinate in target_bbox):
        raise ValueError("target bbox coordinates must be normalized between 0 and 1")
    if right <= left or bottom <= top:
        raise ValueError("target bbox must have positive width and height")
    height, width = grid.shape
    left_column = max(0, min(width - 1, int(np.floor(left * width))))
    top_row = max(0, min(height - 1, int(np.floor(top * height))))
    right_column = max(left_column + 1, min(width, int(np.ceil(right * width))))
    bottom_row = max(top_row + 1, min(height, int(np.ceil(bottom * height))))
    grid[top_row:bottom_row, left_column:right_column] = 2


class SegformerTraversabilitySegmenter:
    """Convert RGB images into candidate/unknown/non-walkable pixel masks."""

    def __init__(self, config: SegmentationConfig | None = None) -> None:
        self.config = config or SegmentationConfig()
        self._processor = None
        self._model = None
        self._device = None
        self.grid = None
        self._load_lock = Lock()

    def _load(self) -> None:
        if self._model is not None:
            return
        with self._load_lock:
            if self._model is not None:
                return
            import torch
            from transformers import AutoImageProcessor, SegformerForSemanticSegmentation

            if torch.backends.mps.is_available():
                device = torch.device("mps")
            elif torch.cuda.is_available():
                device = torch.device("cuda")
            else:
                device = torch.device("cpu")
            try:
                self._processor = AutoImageProcessor.from_pretrained(
                    self.config.model_id, local_files_only=True
                )
                self._model = SegformerForSemanticSegmentation.from_pretrained(
                    self.config.model_id, local_files_only=True
                )
            except OSError:
                self._processor = AutoImageProcessor.from_pretrained(self.config.model_id)
                self._model = SegformerForSemanticSegmentation.from_pretrained(
                    self.config.model_id
                )
            self._model = self._model.to(device)
            self._model.eval()
            self._device = device

    def segment(
        self,
        image: Image.Image,
        target_bbox: tuple[float, float, float, float] | None = None,
    ) -> TraversabilityMask:
        import torch
        import torch.nn.functional as functional

        self._load()
        assert self._processor is not None
        assert self._model is not None
        assert self._device is not None

        rgb = image.convert("RGB")
        width, height = rgb.size
        output_scale = min(
            1.0,
            self.config.maximum_mask_dimension / max(width, height),
        )
        output_width = max(1, round(width * output_scale))
        output_height = max(1, round(height * output_scale))
        started = perf_counter()
        inputs = self._processor(images=rgb, return_tensors="pt")
        inputs = {name: value.to(self._device) for name, value in inputs.items()}
        with torch.inference_mode():
            logits = self._model(**inputs).logits
            logits = functional.interpolate(
                logits,
                size=(output_height, output_width),
                mode="bilinear",
                align_corners=False,
            )
            probabilities = logits.softmax(dim=1)
            confidence, predicted = probabilities.max(dim=1)
        inference_ms = (perf_counter() - started) * 1000

        predicted_array = predicted[0].cpu().numpy()
        confidence_array = confidence[0].cpu().numpy()
        id_to_label = {
            int(index): label.strip().lower()
            for index, label in self._model.config.id2label.items()
        }
        walkable_ids = np.array(
            [
                index
                for index, label in id_to_label.items()
                if label in self.config.candidate_walkable_labels
            ],
            dtype=np.int64,
        )
        if not walkable_ids.size:
            raise RuntimeError(
                "Configured candidate walkable labels are absent from the model"
            )

        confident = confidence_array >= self.config.minimum_pixel_confidence
        raw_candidate = confident & np.isin(predicted_array, walkable_ids)
        candidate = retain_ground_connected(
            raw_candidate.astype(np.bool_),
            lower_band_fraction=self.config.ground_connection_band,
        )
        disconnected_candidate = raw_candidate & ~candidate
        unknown = ~confident | disconnected_candidate
        non_walkable = confident & ~raw_candidate
        blocked = np.zeros((output_height, output_width), dtype=np.bool_)

        def original_size(binary_mask: np.ndarray) -> np.ndarray:
            if binary_mask.shape == (height, width):
                return binary_mask.astype(np.bool_)
            resized = Image.fromarray(binary_mask.astype(np.uint8) * 255).resize(
                (width, height), Image.Resampling.NEAREST
            )
            return np.asarray(resized, dtype=np.uint8) > 0

        mask = TraversabilityMask(
            width=width,
            height=height,
            candidate_walkable_mask=original_size(candidate),
            non_walkable_mask=original_size(non_walkable),
            unknown_mask=original_size(unknown),
            blocked_mask=original_size(blocked),
            inference_ms=inference_ms,
        )
        grid = original_size(raw_candidate).astype(np.uint8)
        if target_bbox is not None:
            mark_target_bbox(grid, target_bbox)
        self.grid = grid
        np.savetxt(Path(__file__).with_name("output.txt"), grid, fmt="%d")
        return mask
