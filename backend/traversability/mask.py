from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace

import numpy as np


@dataclass(frozen=True, slots=True)
class SegmentationConfig:
    """Centralized Phase 1 segmentation and obstacle-fusion settings."""

    model_id: str = "nvidia/segformer-b0-finetuned-ade-512-512"
    minimum_pixel_confidence: float = 0.35
    candidate_walkable_labels: frozenset[str] = frozenset({"floor", "rug"})
    obstacle_padding: float = 0.10
    maximum_mask_dimension: int = 1024
    ground_connection_band: float = 0.15

    def __post_init__(self) -> None:
        if not 0 <= self.minimum_pixel_confidence <= 1:
            raise ValueError("minimum_pixel_confidence must be between 0 and 1")
        if not 0 <= self.obstacle_padding <= 1:
            raise ValueError("obstacle_padding must be between 0 and 1")
        if self.maximum_mask_dimension < 128:
            raise ValueError("maximum_mask_dimension must be at least 128")
        if not 0 < self.ground_connection_band <= 1:
            raise ValueError("ground_connection_band must be greater than 0 and at most 1")


@dataclass(frozen=True, slots=True)
class ObstacleBox:
    """Normalized image-space obstacle box: left, top, right, bottom."""

    label: str
    left: float
    top: float
    right: float
    bottom: float
    confidence: float = 1.0

    def __post_init__(self) -> None:
        coordinates = (self.left, self.top, self.right, self.bottom)
        if any(value < 0 or value > 1 for value in coordinates):
            raise ValueError("obstacle coordinates must be normalized between 0 and 1")
        if self.right <= self.left or self.bottom <= self.top:
            raise ValueError("obstacle box must have positive width and height")
        if not 0 <= self.confidence <= 1:
            raise ValueError("obstacle confidence must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class TraversabilityMask:
    width: int
    height: int
    candidate_walkable_mask: np.ndarray
    non_walkable_mask: np.ndarray
    unknown_mask: np.ndarray
    blocked_mask: np.ndarray
    inference_ms: float

    def __post_init__(self) -> None:
        expected = (self.height, self.width)
        masks = (
            self.candidate_walkable_mask,
            self.non_walkable_mask,
            self.unknown_mask,
            self.blocked_mask,
        )
        if self.width <= 0 or self.height <= 0:
            raise ValueError("mask dimensions must be positive")
        if any(mask.shape != expected or mask.dtype != np.bool_ for mask in masks):
            raise ValueError("all masks must be boolean arrays matching width and height")
        overlap = sum(mask.astype(np.uint8) for mask in masks)
        if np.any(overlap > 1):
            raise ValueError("traversability categories must not overlap")
        if np.any(overlap == 0):
            raise ValueError("every pixel must belong to one traversability category")

    def percentages(self) -> dict[str, float]:
        total = self.width * self.height
        return {
            "candidate_walkable": 100 * int(self.candidate_walkable_mask.sum()) / total,
            "blocked": 100 * int(self.blocked_mask.sum()) / total,
            "unknown": 100 * int(self.unknown_mask.sum()) / total,
            "non_walkable": 100 * int(self.non_walkable_mask.sum()) / total,
        }


def retain_ground_connected(
    candidate: np.ndarray,
    *,
    lower_band_fraction: float,
) -> np.ndarray:
    """Keep candidate regions connected to the lower camera-view band."""
    if candidate.ndim != 2 or candidate.dtype != np.bool_:
        raise ValueError("candidate must be a two-dimensional boolean mask")
    if not 0 < lower_band_fraction <= 1:
        raise ValueError("lower_band_fraction must be greater than 0 and at most 1")

    height, width = candidate.shape
    seed_row = max(0, height - max(1, int(np.ceil(height * lower_band_fraction))))
    retained = np.zeros_like(candidate)
    queue: deque[tuple[int, int]] = deque()
    for row, col in zip(*np.nonzero(candidate[seed_row:])):
        absolute_row = row + seed_row
        if retained[absolute_row, col]:
            continue
        retained[absolute_row, col] = True
        queue.append((absolute_row, col))

    while queue:
        row, col = queue.popleft()
        for row_offset in (-1, 0, 1):
            for col_offset in (-1, 0, 1):
                if row_offset == 0 and col_offset == 0:
                    continue
                next_row = row + row_offset
                next_col = col + col_offset
                if (
                    0 <= next_row < height
                    and 0 <= next_col < width
                    and candidate[next_row, next_col]
                    and not retained[next_row, next_col]
                ):
                    retained[next_row, next_col] = True
                    queue.append((next_row, next_col))
    return retained


def fuse_obstacles(
    mask: TraversabilityMask,
    obstacles: list[ObstacleBox] | tuple[ObstacleBox, ...],
    *,
    padding: float,
) -> TraversabilityMask:
    """Override segmentation with padded planning obstacles."""
    if not 0 <= padding <= 1:
        raise ValueError("padding must be between 0 and 1")

    candidate = mask.candidate_walkable_mask.copy()
    non_walkable = mask.non_walkable_mask.copy()
    unknown = mask.unknown_mask.copy()
    blocked = mask.blocked_mask.copy()

    for obstacle in obstacles:
        box_width = obstacle.right - obstacle.left
        box_height = obstacle.bottom - obstacle.top
        left = max(0.0, obstacle.left - box_width * padding)
        right = min(1.0, obstacle.right + box_width * padding)
        top = max(0.0, obstacle.top - box_height * padding)
        bottom = min(1.0, obstacle.bottom + box_height * padding)

        x1 = max(0, min(mask.width - 1, int(np.floor(left * mask.width))))
        y1 = max(0, min(mask.height - 1, int(np.floor(top * mask.height))))
        x2 = max(x1 + 1, min(mask.width, int(np.ceil(right * mask.width))))
        y2 = max(y1 + 1, min(mask.height, int(np.ceil(bottom * mask.height))))

        candidate[y1:y2, x1:x2] = False
        non_walkable[y1:y2, x1:x2] = False
        unknown[y1:y2, x1:x2] = False
        blocked[y1:y2, x1:x2] = True

    return replace(
        mask,
        candidate_walkable_mask=candidate,
        non_walkable_mask=non_walkable,
        unknown_mask=unknown,
        blocked_mask=blocked,
    )
