import type { Command, Snapshot } from '../shared/protocol';

export const isMovement = (command: Command) => command.action.startsWith('ALIGN_') || command.action.startsWith('HAND_') || command.action === 'STEP_FORWARD';
export function acceptsCommand(command: Command | null, state: Pick<Snapshot, 'revision' | 'phase'>, now: number, capturedAfter: number): command is Command {
  if (!command || command.revision !== state.revision || command.phase !== state.phase || !Number.isFinite(command.capturedAt) || command.capturedAt > now + 100) return false;
  return !isMovement(command) || (now - command.capturedAt <= 4000 && command.capturedAt >= capturedAfter && command.expiresInMs > 0);
}
export function commandDeadline(command: Command, now: number) {
  return isMovement(command) ? Math.min(now + Math.min(command.expiresInMs, 2000), command.capturedAt + 4000) : Infinity;
}

export function fallbackGuidance(state: Pick<Snapshot, 'target' | 'observation'>): { text: string; reason: string } | null {
  const observation = state.observation;
  if (!observation) return null;
  const reason = observation.evidence.trim() ? `Gemini sees: ${observation.evidence.trim()}` : 'Gemini is checking the current view.';
  if (observation.view === 'blurred') return { text: 'Hold the camera steady.', reason };
  if (observation.view === 'obstructed') return { text: 'Uncover the camera.', reason };
  if (state.target && observation.targetMatch !== 'matched') return { text: `Turn slowly until ${state.target.description} is back in view.`, reason };
  if (observation.proximity === 'near' || (observation.targetBox && (observation.targetBox.right - observation.targetBox.left >= .7 || observation.targetBox.bottom - observation.targetBox.top >= .7))) return { text: 'Stop. The target is close.', reason };
  if (!state.target && observation.candidates.length === 0) return { text: 'Turn slowly to scan for the object.', reason };
  if (observation.uncertain) return { text: 'Hold still while I confirm the target.', reason };
  return { text: 'Hold still while I confirm the next step.', reason };
}
