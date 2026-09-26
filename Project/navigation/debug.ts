import { getDesiredDirection } from './heading.js';
import { Cell, type NavigationDecision, type NavigationState } from './types.js';

export function formatDecision(state: NavigationState, decision: NavigationDecision): string {
  const path = new Set(decision.path.map(({ row, col }) => `${row},${col}`));
  const lines = state.grid.map((row, rowIndex) => row.map((cell, colIndex) => {
    if (state.user.row === rowIndex && state.user.col === colIndex) return 'U';
    if (state.target?.row === rowIndex && state.target.col === colIndex) return 'T';
    if (path.has(`${rowIndex},${colIndex}`)) return '*';
    return cell === Cell.OCCUPIED ? '#' : cell === Cell.UNKNOWN ? '?' : '.';
  }).join(' '));
  const desired = decision.nextCell ? getDesiredDirection(state.user, decision.nextCell) : 'N/A';
  return [
    ...lines,
    '',
    `Target confidence: ${state.target?.confidence ?? 'N/A'}`,
    `User heading: ${state.user.heading}`,
    `Path length: ${decision.path.length}`,
    `Next cell: ${decision.nextCell ? `(${decision.nextCell.row}, ${decision.nextCell.col})` : 'N/A'}`,
    `Next desired direction: ${desired}`,
    `Decision: ${decision.action}`,
    `Reason: ${decision.reason}`,
    `Preprocessing time: ${decision.timing.preprocessingMs.toFixed(3)} ms`,
    `Planning time: ${decision.timing.planningMs.toFixed(3)} ms`,
    `Decision time: ${decision.timing.decisionMs.toFixed(3)} ms`,
    `Total engine time: ${decision.timing.totalMs.toFixed(3)} ms`,
  ].join('\n');
}

