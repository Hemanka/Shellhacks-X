import { Cell, type NavigationState } from './types.js';

function state(grid: Cell[][], user: NavigationState['user'], target: NonNullable<NavigationState['target']>, timestamp = 1): NavigationState {
  return { grid, user, target, timestamp };
}

const F = Cell.FREE, O = Cell.OCCUPIED, X = Cell.UNKNOWN;

export const mockScenarios = {
  straight: state([[F,F,F,F,F],[F,F,F,F,F],[F,F,F,F,F],[F,F,F,F,F],[F,F,F,F,F]], { row: 4, col: 2, heading: 'NORTH' }, { row: 0, col: 2, confidence: .94 }),
  rightTurn: state([[F,F,F,F,F],[F,F,F,F,F],[F,F,F,F,F],[F,F,F,F,F]], { row: 3, col: 2, heading: 'NORTH' }, { row: 0, col: 4, confidence: .94 }),
  obstacle: state([[F,F,F,F,F],[F,F,O,F,F],[F,F,O,F,F],[F,F,O,F,F],[F,F,F,F,F]], { row: 4, col: 2, heading: 'NORTH' }, { row: 0, col: 2, confidence: .94 }),
  unknownRegion: state([[X,X,F,X,X],[X,F,F,F,X],[X,F,F,F,X],[X,F,F,F,X]], { row: 3, col: 2, heading: 'NORTH' }, { row: 0, col: 2, confidence: .94 }),
  noPath: state([[O,O,F,O,O],[O,O,O,O,O],[F,F,F,F,F],[F,F,F,F,F]], { row: 3, col: 2, heading: 'NORTH' }, { row: 0, col: 2, confidence: .94 }),
  dynamicFrame1: state([[F,F,F],[F,F,F],[F,F,F]], { row: 2, col: 1, heading: 'NORTH' }, { row: 0, col: 1, confidence: .94 }, 1),
  dynamicFrame2: state([[F,F,F],[F,O,F],[F,F,F]], { row: 2, col: 1, heading: 'NORTH' }, { row: 0, col: 1, confidence: .94 }, 2),
  lowConfidence: state([[F,F,F],[F,F,F]], { row: 1, col: 1, heading: 'NORTH' }, { row: 0, col: 1, confidence: .35 }),
  arrived: state([[F,F,F],[F,F,F]], { row: 1, col: 1, heading: 'NORTH' }, { row: 1, col: 1, confidence: .94 }),
} satisfies Record<string, NavigationState>;

