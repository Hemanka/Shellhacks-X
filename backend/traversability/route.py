"""Image-space floor routes that steer toward a detected target around obstacles."""
from heapq import heappop, heappush
import math

import numpy as np

from .mask import TraversabilityMask


# Keep the route grid fine enough to follow curved segmentation boundaries.
ROWS, COLS = 96, 128
DIRECTIONS = (("LEFT", 32), ("CENTER", 64), ("RIGHT", 95))


def _path(parents: dict, end: tuple[int, int]) -> list[tuple[int, int]]:
    result = []
    node = end
    while node is not None:
        result.append(node)
        node = parents[node]
    result.reverse()
    return result


def _line_clear(start: tuple[int, int], end: tuple[int, int], allowed: np.ndarray) -> bool:
    steps = max(abs(end[0] - start[0]), abs(end[1] - start[1])) * 3
    if not steps:
        return bool(allowed[start])
    for index in range(steps + 1):
        amount = index / steps
        row = round(start[0] + (end[0] - start[0]) * amount)
        col = round(start[1] + (end[1] - start[1]) * amount)
        if not allowed[row, col]:
            return False
    return True


def _pull_taut(path: list[tuple[int, int]], allowed: np.ndarray) -> list[tuple[int, int]]:
    """Remove grid zigzags only when the straight segment stays in clear space."""
    if len(path) < 3:
        return path
    result = [path[0]]
    current = 0
    while current < len(path) - 1:
        end = len(path) - 1
        while end > current + 1 and not _line_clear(path[current], path[end], allowed):
            end -= 1
        result.append(path[end])
        current = end
    return result


def _action(path: list[tuple[int, int]]) -> str:
    """Choose the immediate action from the first four grid cells of the path."""
    start = path[0]
    look = path[min(len(path) - 1, 4)]
    dx = look[1] - start[1]
    return "TURN_LEFT" if dx <= -2 else "TURN_RIGHT" if dx >= 2 else "FORWARD"


def _route(direction: str, path: list[tuple[int, int]], certainty: str,
           score: float | None = None, allowed: np.ndarray | None = None) -> dict:
    points = _pull_taut(path, allowed) if allowed is not None else path
    result = {
        "direction": direction,
        "action": _action(path),
        "points": [[(c + .5) / COLS, (r + .5) / ROWS] for r, c in points],
        "certainty": certainty,
    }
    if score is not None:
        result["estimatedCost"] = round(score, 2)
    return result


def _grid_layers(mask: TraversabilityMask) -> tuple[np.ndarray, ...]:
    ys = np.linspace(0, mask.height, ROWS + 1, dtype=int)
    xs = np.linspace(0, mask.width, COLS + 1, dtype=int)
    floor = np.zeros((ROWS, COLS), dtype=float)
    unknown = np.zeros_like(floor)
    non_walkable = np.zeros_like(floor)
    blocked = np.zeros_like(floor)
    for r in range(ROWS):
        for c in range(COLS):
            sl = np.s_[ys[r]:ys[r + 1], xs[c]:xs[c + 1]]
            area = max(1, (ys[r + 1] - ys[r]) * (xs[c + 1] - xs[c]))
            floor[r, c] = mask.candidate_walkable_mask[sl].sum() / area
            unknown[r, c] = mask.unknown_mask[sl].sum() / area
            non_walkable[r, c] = mask.non_walkable_mask[sl].sum() / area
            blocked[r, c] = mask.blocked_mask[sl].sum() / area
    return floor, unknown, non_walkable, blocked


def _inflate(obstacle: np.ndarray) -> np.ndarray:
    """Add a round clearance buffer, preserving the obstacle's pixel contour."""
    inflated = np.zeros_like(obstacle)
    radius = 2
    padded = np.pad(obstacle, radius, constant_values=False)
    for dr in range(2 * radius + 1):
        for dc in range(2 * radius + 1):
            if (dr - radius) ** 2 + (dc - radius) ** 2 <= radius ** 2:
                inflated |= padded[dr:dr + ROWS, dc:dc + COLS]
    return inflated


def _search(floor: np.ndarray, unknown: np.ndarray, non_walkable: np.ndarray,
            blocked: np.ndarray) -> tuple[dict, dict, np.ndarray]:
    # Even an estimated route must not pass through detected furniture or objects.
    obstacle = _inflate((blocked >= .04) | (non_walkable >= .20))
    allowed = ~obstacle
    costs = 1.0 + 5.0 * unknown + 3.0 * non_walkable + 2.5 * (1.0 - floor)
    seeds = [(r, c) for r in range(87, 96) for c in range(52, 77) if allowed[r, c]]
    if not seeds:
        return {}, {}, obstacle
    start = min(seeds, key=lambda rc: costs[rc] + abs(rc[1] - 63.5) * .5 + (95 - rc[0]) * .25)
    distances = {start: 0.0}
    parents: dict[tuple[int, int], tuple[int, int] | None] = {start: None}
    queue = [(0.0, start)]
    while queue:
        distance, node = heappop(queue)
        if distance != distances[node]:
            continue
        r, c = node
        for dr, dc in ((-1, 0), (0, -1), (0, 1), (1, 0), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            nxt = (r + dr, c + dc)
            if not (0 <= nxt[0] < ROWS and 0 <= nxt[1] < COLS and allowed[nxt]):
                continue
            if dr and dc and (obstacle[r + dr, c] or obstacle[r, c + dc]):
                continue
            candidate = distance + math.hypot(dr, dc) * (costs[node] + costs[nxt]) / 2
            if candidate < distances.get(nxt, float("inf")):
                distances[nxt] = candidate
                parents[nxt] = node
                heappush(queue, (candidate, nxt))
    return distances, parents, obstacle


def _legacy_routes(floor: np.ndarray, unknown: np.ndarray, non_walkable: np.ndarray,
                   blocked: np.ndarray) -> list[dict]:
    distances, parents, obstacle = _search(floor, unknown, non_walkable, blocked)
    if not distances:
        return []
    routes = []
    for direction, desired in DIRECTIONS:
        candidates = [rc for rc in distances if 40 <= rc[0] <= 70 and abs(rc[1] - desired) <= 18]
        if not candidates:
            continue
        end = min(candidates, key=lambda rc: distances[rc] + abs(rc[1] - desired) * 1.5 + abs(rc[0] - 56) * .5)
        path = _path(parents, end)
        confirmed = all(floor[r, c] >= .85 and unknown[r, c] < .1 and non_walkable[r, c] < .1
                        and not obstacle[r, c] for r, c in path)
        shortcut_space = (floor >= .2) & ~obstacle
        routes.append(_route(direction, path, "confirmed" if confirmed else "estimated", distances[end], shortcut_space))
    return routes


def _target_route(floor: np.ndarray, unknown: np.ndarray, non_walkable: np.ndarray,
                  blocked: np.ndarray, target_bbox: tuple[float, float, float, float],
                  direction: str) -> list[dict]:
    distances, parents, obstacle = _search(floor, unknown, non_walkable, blocked)
    if not distances:
        return []
    left, top, right, bottom = target_bbox
    target_col = min(COLS - 1, max(0, int(((left + right) / 2) * COLS)))
    # Stop just in front of the target's image location; never draw through it.
    target_row = min(ROWS - 5, max(12, int(bottom * ROWS) + 8))
    candidates = [
        (r, c) for r, c in distances
        if abs(r - target_row) <= 12 and abs(c - target_col) <= 18
    ]
    if not candidates:
        candidates = [rc for rc in distances if rc[0] < 87]
    if not candidates:
        return []
    end = min(candidates, key=lambda rc: distances[rc] +
              2.0 * math.hypot((rc[0] - target_row) * 1.2, rc[1] - target_col))
    path = _path(parents, end)
    confirmed = all(floor[r, c] >= .85 and unknown[r, c] < .1 and non_walkable[r, c] < .1
                    and not obstacle[r, c] for r, c in path)
    shortcut_space = (floor >= .2) & ~obstacle
    return [_route(direction, path, "confirmed" if confirmed else "estimated", distances[end], shortcut_space)]


def plan_routes(
    mask: TraversabilityMask,
    target_bbox: tuple[float, float, float, float] | list[float] | None = None,
    target_direction: str = "CENTER",
) -> dict:
    floor, unknown, non_walkable, blocked = _grid_layers(mask)
    if target_bbox and len(target_bbox) == 4:
        routes = _target_route(floor, unknown, non_walkable, blocked,
                               tuple(float(value) for value in target_bbox), target_direction)
    else:
        routes = _legacy_routes(floor, unknown, non_walkable, blocked)
    if routes:
        certainty = "available" if routes[0]["certainty"] == "confirmed" else "estimated"
        return {"status": certainty, "reason": "Floor route toward the target, buffered around detected obstacles", "routes": routes}
    return {"status": "blocked", "reason": "No route avoids the detected obstacles", "routes": []}
