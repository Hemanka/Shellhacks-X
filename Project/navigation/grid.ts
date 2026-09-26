import { Cell, type GridPosition, type NavigationState } from './types.js';

export type PlanningGrid = Array<Array<number | null>>;

export function isInBounds(grid: readonly (readonly unknown[])[], position: GridPosition): boolean {
  return position.row >= 0 && position.row < grid.length && position.col >= 0 && position.col < (grid[position.row]?.length ?? 0);
}

export function validateState(state: NavigationState): string | null {
  if (!Array.isArray(state.grid) || state.grid.length === 0) return 'INVALID_GRID';
  const width = state.grid[0]?.length ?? 0;
  if (width === 0 || state.grid.some(row => !Array.isArray(row) || row.length !== width)) return 'INVALID_GRID';
  if (state.grid.some(row => row.some(cell => cell !== Cell.FREE && cell !== Cell.OCCUPIED && cell !== Cell.UNKNOWN))) return 'INVALID_GRID';
  if (!Number.isInteger(state.user.row) || !Number.isInteger(state.user.col) || !isInBounds(state.grid, state.user)) return 'INVALID_USER_POSITION';
  if (!['NORTH', 'EAST', 'SOUTH', 'WEST'].includes(state.user.heading)) return 'INVALID_USER_POSITION';
  if (state.target && (!Number.isInteger(state.target.row) || !Number.isInteger(state.target.col) || !isInBounds(state.grid, state.target))) return 'INVALID_TARGET_POSITION';
  if (!Number.isFinite(state.timestamp)) return 'INVALID_GRID';
  return null;
}

export function inflateObstacles(
  grid: readonly (readonly Cell[])[],
  radius: number,
  protectedCells: readonly GridPosition[] = [],
): Cell[][] {
  const result = grid.map(row => [...row]);
  if (radius <= 0) return result;
  const protectedKeys = new Set(protectedCells.map(({ row, col }) => `${row},${col}`));
  for (let row = 0; row < grid.length; row++) {
    for (let col = 0; col < grid[row].length; col++) {
      if (grid[row][col] !== Cell.OCCUPIED) continue;
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const candidate = { row: row + dr, col: col + dc };
          if (isInBounds(grid, candidate) && !protectedKeys.has(`${candidate.row},${candidate.col}`)) {
            result[candidate.row][candidate.col] = Cell.OCCUPIED;
          }
        }
      }
    }
  }
  return result;
}

export function toPlanningGrid(grid: readonly (readonly Cell[])[], allowUnknown: boolean, unknownCost: number): PlanningGrid {
  return grid.map(row => row.map(cell => {
    if (cell === Cell.FREE) return 1;
    if (cell === Cell.UNKNOWN && allowUnknown) return unknownCost;
    return null;
  }));
}
