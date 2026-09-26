import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsCommand, commandDeadline, fallbackGuidance } from './guidanceSafety';
import type { Command } from '../shared/protocol';
const state = { revision: 3, phase: 'approaching' as const };
const base: Command = { id: 1, frameId: 1, capturedAt: 1000, revision: 3, phase: 'approaching', action: 'STEP_FORWARD', text: 'One step.', reason: 'Matched.', expiresInMs: 2000 };
test('movement rejects frames captured before the expiry barrier', () => {
  assert.equal(acceptsCommand(base, state, 2000, 1500), false);
  assert.equal(acceptsCommand({ ...base, capturedAt: 1500 }, state, 2000, 1500), true);
});
test('movement requires a fresh frame and matching state', () => {
  assert.equal(acceptsCommand(base, state, 5000, 0), true);
  assert.equal(acceptsCommand(base, state, 5001, 0), false);
  assert.equal(acceptsCommand({ ...base, revision: 2 }, state, 2000, 0), false);
  assert.equal(acceptsCommand({ ...base, phase: 'reaching' }, state, 2000, 0), false);
  assert.equal(acceptsCommand({ ...base, capturedAt: 2101 }, state, 2000, 0), false);
});
test('movement deadline caps both cue duration and frame age', () => {
  assert.equal(commandDeadline({ ...base, expiresInMs: 8000 }, 2000), 4000);
  assert.equal(commandDeadline(base, 4500), 5000);
  assert.equal(acceptsCommand({ ...base, expiresInMs: 0 }, state, 2000, 0), false);
});
test('nonmovement guidance with zero expiry remains visible', () => {
  for (const action of ['STOP', 'HOLD', 'ADJUST_VIEW', 'NO_CHANGE'] as const) {
    const command = { ...base, action, expiresInMs: 0 };
    assert.equal(acceptsCommand(command, state, 9000, 8000), true);
    assert.equal(commandDeadline(command, 9000), Infinity);
  }
});
test('fallback guidance surfaces Gemini evidence as an actionable next step', () => {
  const observation = { view: 'usable' as const, candidates: [], targetMatch: 'lost' as const, targetBox: null, targetScale: 'none' as const, direction: 'unknown' as const, proximity: 'uncertain' as const, reachability: 'uncertain' as const, handVisible: false, handCorrection: 'unknown' as const, uncertain: true, evidence: 'Pizza box is no longer visible.' };
  assert.deepEqual(fallbackGuidance({ target: { id: 'box', description: 'orange pizza box', box: { left: .1, top: .1, right: .5, bottom: .5 } }, observation }), {
    text: 'Turn slowly until orange pizza box is back in view.',
    reason: 'Gemini sees: Pizza box is no longer visible.',
  });
  assert.equal(fallbackGuidance({ target: null, observation })?.text, 'Turn slowly to scan for the object.');
  assert.equal(fallbackGuidance({ target: null, observation: { ...observation, view: 'blurred' } })?.text, 'Hold the camera steady.');
  assert.equal(fallbackGuidance({ target: null, observation: { ...observation, targetMatch: 'matched', targetScale: 'large', proximity: 'near', uncertain: false } })?.text, 'Stop. The target is close.');
});
