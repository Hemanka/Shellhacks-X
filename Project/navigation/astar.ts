import { isInBounds, type PlanningGrid } from './grid.js';
import type { GridPosition } from './types.js';

export function manhattan(a: GridPosition, b: GridPosition): number {
  return Math.abs(a.row - b.row) + Math.abs(a.col - b.col);
}

// East-first ordering makes equally short paths deterministic for demonstrations.
const OFFSETS = [[0, 1], [-1, 0], [0, -1], [1, 0]] as const;

export function getNeighbors(grid: PlanningGrid, position: GridPosition): GridPosition[] {
  return OFFSETS
    .map(([dr, dc]) => ({ row: position.row + dr, col: position.col + dc }))
    .filter(candidate => isInBounds(grid, candidate) && grid[candidate.row][candidate.col] !== null);
}

function key(position: GridPosition): string {
  return `${position.row},${position.col}`;
}

function reconstruct(cameFrom: Map<string, GridPosition>, current: GridPosition): GridPosition[] {
  const path = [current];
  while (cameFrom.has(key(current))) {
    current = cameFrom.get(key(current))!;
    path.push(current);
  }
  return path.reverse();
}

export function findPath(grid: PlanningGrid, start: GridPosition, goal: GridPosition): GridPosition[] | null {
  if (!isInBounds(grid, start) || !isInBounds(grid, goal) || grid[start.row][start.col] === null || grid[goal.row][goal.col] === null) return null;
  const startPosition = { row: start.row, col: start.col };
  const open: Array<{ position: GridPosition; f: number; h: number; order: number }> = [];
  const cameFrom = new Map<string, GridPosition>();
  const gScore = new Map<string, number>([[key(startPosition), 0]]);
  const closed = new Set<string>();
  let order = 0;
  open.push({ position: startPosition, f: manhattan(startPosition, goal), h: manhattan(startPosition, goal), order: order++ });

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f || a.h - b.h || a.order - b.order);
    const current = open.shift()!.position;
    const currentKey = key(current);
    if (closed.has(currentKey)) continue;
    if (current.row === goal.row && current.col === goal.col) return reconstruct(cameFrom, current);
    closed.add(currentKey);

    for (const neighbor of getNeighbors(grid, current)) {
      const neighborKey = key(neighbor);
      if (closed.has(neighborKey)) continue;
      const tentative = gScore.get(currentKey)! + grid[neighbor.row][neighbor.col]!;
      if (tentative >= (gScore.get(neighborKey) ?? Infinity)) continue;
      cameFrom.set(neighborKey, current);
      gScore.set(neighborKey, tentative);
      const h = manhattan(neighbor, goal);
      open.push({ position: neighbor, f: tentative + h, h, order: order++ });
    }
  }
  return null;
}
