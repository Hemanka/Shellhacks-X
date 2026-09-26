export enum Cell {
  FREE = 0,
  OCCUPIED = 1,
  UNKNOWN = 2,
}

export type Direction = 'NORTH' | 'EAST' | 'SOUTH' | 'WEST';

export interface GridPosition {
  row: number;
  col: number;
}

export interface NavigationState {
  grid: Cell[][];
  user: GridPosition & { heading: Direction };
  target: (GridPosition & { confidence: number }) | null;
  timestamp: number;
}

export type NavigationAction =
  | 'FORWARD'
  | 'TURN_LEFT'
  | 'TURN_RIGHT'
  | 'HOLD'
  | 'REACQUIRE'
  | 'ARRIVED'
  | 'NO_PATH';

export type NavigationReason =
  | 'PATH_AVAILABLE'
  | 'TARGET_MISSING'
  | 'TARGET_CONFIDENCE_LOW'
  | 'ALREADY_AT_TARGET'
  | 'INVALID_GRID'
  | 'INVALID_USER_POSITION'
  | 'INVALID_TARGET_POSITION'
  | 'USER_CELL_BLOCKED'
  | 'TARGET_BLOCKED'
  | 'USER_SURROUNDED'
  | 'UNKNOWN_SPACE_BLOCKING_ROUTE'
  | 'NO_OBSERVED_ROUTE';

export interface NavigationTiming {
  preprocessingMs: number;
  planningMs: number;
  decisionMs: number;
  totalMs: number;
}

export interface NavigationDecision {
  action: NavigationAction;
  confidence: number;
  reason: NavigationReason;
  path: GridPosition[];
  nextCell: GridPosition | null;
  shouldReplan: boolean;
  timing: NavigationTiming;
}

/** Stable transport contract for audio, logging, or another downstream service. */
export interface NavigationDecisionEnvelope {
  schemaVersion: 1;
  sourceTimestamp: number;
  generatedAt: number;
  decision: NavigationDecision;
}

export interface NavigationConfig {
  allowUnknown: boolean;
  unknownCost: number;
  clearanceRadius: number;
  minimumTargetConfidence: number;
  arrivalRadius: number;
}

export const DEFAULT_NAVIGATION_CONFIG: Readonly<NavigationConfig> = {
  allowUnknown: false,
  unknownCost: 5,
  clearanceRadius: 0,
  minimumTargetConfidence: 0.7,
  arrivalRadius: 0,
};
