import type { Observation } from '../shared/protocol.js';

/** Normalized mean absolute luminance change. Missing/mismatched images force analysis. */
export function grayscaleDiff(previous: Uint8Array | null, current: Uint8Array): number {
  if (!previous || !current.length || previous.length !== current.length) return 1;
  let sum = 0;
  for (let i = 0; i < current.length; i++) sum += Math.abs(current[i] - previous[i]);
  return sum / (current.length * 255);
}
export function shouldAnalyze(diff: number, elapsedMs: number, forced: boolean): boolean {
  return forced || !Number.isFinite(diff) || diff >= .04 || elapsedMs >= 3000;
}
export function semanticKey(o: Observation, phase: string): string {
  return JSON.stringify([phase, o.view, o.targetMatch, o.targetScale, o.direction, o.proximity, o.reachability, o.handVisible, o.handCorrection, o.uncertain]);
}
export function shouldReason(key: string, previousKey: string, forced: boolean): boolean {
  return forced || key !== previousKey;
}
export function frameIsCurrent(frameRevision: number, revision: number, receivedAt: number, now: number, disposed = false): boolean {
  return !disposed && frameRevision === revision && receivedAt <= now && now - receivedAt <= 4000;
}
export function canCarryObservationForward(analyzedGray: Uint8Array, currentGray: Uint8Array, currentRevision: number, revision: number, currentReceivedAt: number, now: number): boolean {
  return frameIsCurrent(currentRevision, revision, currentReceivedAt, now) && grayscaleDiff(analyzedGray, currentGray) < .025;
}
