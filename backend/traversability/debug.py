from __future__ import annotations

import argparse
import base64
import json
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from .mask import ObstacleBox, SegmentationConfig, TraversabilityMask, fuse_obstacles
from .segmenter import SegformerTraversabilitySegmenter


COLORS = {
    "candidate": np.array([45, 190, 95], dtype=np.uint8),
    "blocked": np.array([230, 55, 65], dtype=np.uint8),
    "unknown": np.array([120, 125, 135], dtype=np.uint8),
    "non_walkable": np.array([35, 42, 55], dtype=np.uint8),
}


def load_obstacles(path: Path | None) -> list[ObstacleBox]:
    if path is None:
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    entries = raw.get("obstacles", []) if isinstance(raw, dict) else raw
    if not isinstance(entries, list):
        raise ValueError("obstacle JSON must be a list or contain an obstacles list")
    obstacles = []
    for item in entries:
        bbox = item.get("bbox") or item.get("box")
        if isinstance(bbox, dict):
            coordinates = [bbox[name] for name in ("left", "top", "right", "bottom")]
        elif isinstance(bbox, list) and len(bbox) == 4:
            coordinates = bbox
        else:
            raise ValueError("each obstacle needs bbox [left, top, right, bottom]")
        obstacles.append(
            ObstacleBox(
                label=str(item.get("label", "obstacle")),
                left=float(coordinates[0]),
                top=float(coordinates[1]),
                right=float(coordinates[2]),
                bottom=float(coordinates[3]),
                confidence=float(item.get("confidence", 1)),
            )
        )
    return obstacles


def color_mask(mask: TraversabilityMask) -> Image.Image:
    pixels = np.empty((mask.height, mask.width, 3), dtype=np.uint8)
    pixels[mask.non_walkable_mask] = COLORS["non_walkable"]
    pixels[mask.unknown_mask] = COLORS["unknown"]
    pixels[mask.candidate_walkable_mask] = COLORS["candidate"]
    pixels[mask.blocked_mask] = COLORS["blocked"]
    return Image.fromarray(pixels, mode="RGB")


def overlay_mask(original: Image.Image, mask: TraversabilityMask) -> Image.Image:
    base = np.asarray(original.convert("RGB"), dtype=np.float32)
    colors = np.asarray(color_mask(mask), dtype=np.float32)
    blended = (base * 0.58 + colors * 0.42).clip(0, 255).astype(np.uint8)
    return Image.fromarray(blended, mode="RGB")


def transparent_overlay(
    mask: TraversabilityMask,
    *,
    maximum_dimension: int = 960,
) -> Image.Image:
    """Render a browser-friendly transparent categorical overlay.

    Candidate floor is deliberately labelled as a candidate rather than safe.
    Non-walkable pixels stay transparent so the camera feed remains readable.
    """
    pixels = np.zeros((mask.height, mask.width, 4), dtype=np.uint8)
    pixels[mask.candidate_walkable_mask] = [45, 220, 115, 105]
    pixels[mask.unknown_mask] = [145, 150, 160, 55]
    pixels[mask.blocked_mask] = [245, 55, 65, 175]
    overlay = Image.fromarray(pixels, mode="RGBA")
    scale = min(1.0, maximum_dimension / max(mask.width, mask.height))
    if scale < 1:
        overlay = overlay.resize(
            (max(1, round(mask.width * scale)), max(1, round(mask.height * scale))),
            Image.Resampling.NEAREST,
        )
    return overlay


def overlay_data_url(mask: TraversabilityMask) -> str:
    output = BytesIO()
    transparent_overlay(mask).save(output, format="PNG", optimize=True)
    encoded = base64.b64encode(output.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def render_debug(
    original: Image.Image,
    mask: TraversabilityMask,
    output: Path,
) -> None:
    rgb = original.convert("RGB")
    overlay = overlay_mask(rgb, mask)
    categorical = color_mask(mask)
    header_height = 70
    canvas = Image.new(
        "RGB",
        (mask.width * 3, mask.height + header_height),
        "white",
    )
    canvas.paste(rgb, (0, header_height))
    canvas.paste(overlay, (mask.width, header_height))
    canvas.paste(categorical, (mask.width * 2, header_height))
    draw = ImageDraw.Draw(canvas)
    draw.text((10, 10), "ORIGINAL", fill="black")
    draw.text((mask.width + 10, 10), "TRAVERSABILITY OVERLAY", fill="black")
    draw.text((mask.width * 2 + 10, 10), "CATEGORICAL MASK", fill="black")
    legend = (
        "GREEN candidate walkable   RED detected obstacle   "
        "GRAY unknown   DARK non-walkable"
    )
    draw.text((10, 38), legend, fill="black")
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a candidate walkable-area debug visualization."
    )
    parser.add_argument("image", type=Path, help="Input RGB photograph")
    parser.add_argument(
        "--output", "-o", type=Path, default=Path("walkable-debug.png")
    )
    parser.add_argument(
        "--obstacles",
        type=Path,
        help="Optional JSON containing normalized obstacle bounding boxes",
    )
    parser.add_argument("--confidence", type=float, default=0.35)
    parser.add_argument("--obstacle-padding", type=float, default=0.10)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not args.image.is_file():
        raise SystemExit(f"Input image does not exist: {args.image}")
    config = SegmentationConfig(
        minimum_pixel_confidence=args.confidence,
        obstacle_padding=args.obstacle_padding,
    )
    original = Image.open(args.image).convert("RGB")
    mask = SegformerTraversabilitySegmenter(config).segment(original)
    obstacles = load_obstacles(args.obstacles)
    mask = fuse_obstacles(mask, obstacles, padding=config.obstacle_padding)
    render_debug(original, mask, args.output)

    stats = mask.percentages()
    print(f"Candidate walkable pixels: {stats['candidate_walkable']:.2f}%")
    print(f"Blocked pixels: {stats['blocked']:.2f}%")
    print(f"Unknown pixels: {stats['unknown']:.2f}%")
    print(f"Non-walkable pixels: {stats['non_walkable']:.2f}%")
    print(f"Inference time: {mask.inference_ms:.1f} ms")
    print(f"Debug visualization: {args.output.resolve()}")


if __name__ == "__main__":
    main()
