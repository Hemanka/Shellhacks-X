"""Short image-space routes through connected candidate floor, not metric paths."""
from collections import deque
import numpy as np
from .mask import TraversabilityMask


def plan_routes(mask: TraversabilityMask) -> dict:
    # Small grid with conservative coverage; unknown and furniture are not floor.
    rows, cols = 24, 32
    floor = mask.candidate_walkable_mask & ~mask.blocked_mask & ~mask.unknown_mask
    ys, xs = np.linspace(0, mask.height, rows+1, dtype=int), np.linspace(0, mask.width, cols+1, dtype=int)
    grid = np.zeros((rows, cols), dtype=bool)
    for r in range(rows):
        for c in range(cols):
            cell = floor[ys[r]:ys[r+1], xs[c]:xs[c+1]]
            grid[r,c] = cell.size > 0 and cell.mean() >= .85
    # Require lateral clearance instead of following single-pixel green threads.
    clear = grid.copy()
    clear[:,1:-1] &= grid[:,:-2] & grid[:,2:]
    clear[:,0] = clear[:,-1] = False
    seeds = [(r,c) for r in range(21,24) for c in range(14,18) if clear[r,c]]
    if not seeds:
        return {"status":"blocked", "reason":"No connected floor at the near-center starting region", "routes":[]}
    start = min(seeds, key=lambda rc:abs(rc[1]-15.5)+(23-rc[0]))
    parents = {start:None}; queue = deque([start])
    while queue:
        r,c = queue.popleft()
        for dr,dc in [(-1,0),(0,-1),(0,1),(1,0)]:
            nxt = (r+dr,c+dc)
            if 0 <= nxt[0] < rows and 0 <= nxt[1] < cols and clear[nxt] and nxt not in parents:
                parents[nxt] = (r,c); queue.append(nxt)
    routes=[]
    for direction, desired in [("LEFT",8),("CENTER",16),("RIGHT",23)]:
        # Only plan a short visible corridor, never extrapolate beyond the mask.
        candidates=[rc for rc in parents if 10 <= rc[0] <= 17 and abs(rc[1]-desired)<=4]
        if not candidates: continue
        end=min(candidates,key=lambda rc:abs(rc[1]-desired)*2+abs(rc[0]-14))
        path=[]; node=end
        while node is not None:
            path.append(node); node=parents[node]
        path.reverse()
        look=next((node for node in path if abs(node[1]-start[1]) >= 2), path[-1])
        dx=look[1]-start[1]
        action="TURN_LEFT" if dx <= -2 else "TURN_RIGHT" if dx >= 2 else "FORWARD"
        routes.append({"direction":direction,"action":action,"points":[[(c+.5)/cols,(r+.5)/rows] for r,c in path],"coverage":.85})
    return {"status":"available" if routes else "blocked", "reason":"Connected candidate floor corridors" if routes else "Floor corridor ends before a useful next step", "routes":routes}
