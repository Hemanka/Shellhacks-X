"""Candidate traversability masks for local visual planning experiments."""

from .mask import (
    ObstacleBox,
    SegmentationConfig,
    TraversabilityMask,
    fuse_obstacles,
    retain_ground_connected,
)

__all__ = [
    "ObstacleBox",
    "SegmentationConfig",
    "TraversabilityMask",
    "fuse_obstacles",
    "retain_ground_connected",
]
