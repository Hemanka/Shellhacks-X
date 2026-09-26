import type { Direction, GridPosition, NavigationAction } from './types.js';

const DIRECTIONS: readonly Direction[] = ['NORTH', 'EAST', 'SOUTH', 'WEST'];

export function getDesiredDirection(current: GridPosition, next: GridPosition): Direction {
  const dr = next.row - current.row;
  const dc = next.col - current.col;
  if (dr === -1 && dc === 0) return 'NORTH';
  if (dr === 0 && dc === 1) return 'EAST';
  if (dr === 1 && dc === 0) return 'SOUTH';
  if (dr === 0 && dc === -1) return 'WEST';
  throw new Error('Next position must be orthogonally adjacent to current position.');
}

export function getRequiredAction(current: GridPosition, heading: Direction, next: GridPosition): Extract<NavigationAction, 'FORWARD' | 'TURN_LEFT' | 'TURN_RIGHT'> {
  const desired = getDesiredDirection(current, next);
  const delta = (DIRECTIONS.indexOf(desired) - DIRECTIONS.indexOf(heading) + 4) % 4;
  if (delta === 0) return 'FORWARD';
  if (delta === 3) return 'TURN_LEFT';
  // A 180-degree change consistently begins with a right turn for the MVP.
  return 'TURN_RIGHT';
}

