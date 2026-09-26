import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSchema } from '../shared/protocol.js';
import { normalizeObservationPayload } from '../server/gemini.js';

const observation = (box: Record<string, number>) => ({
  view: 'usable',
  candidates: [{ description: 'orange pizza box', box, usable: true }],
  targetMatch: 'lost',
  targetBox: null,
  targetScale: 'none',
  direction: 'center',
  proximity: 'far',
  reachability: 'uncertain',
  handVisible: false,
  handCorrection: 'unknown',
  uncertain: false,
  evidence: 'visible orange box',
});

test('normalizes Gemini 0-1000 bounding boxes', () => {
  const parsed = observationSchema.parse(normalizeObservationPayload(observation({ left: 100, top: 200, right: 900, bottom: 800 })));
  assert.deepEqual(parsed.candidates[0].box, { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 });
});

test('preserves normalized bounding boxes', () => {
  const parsed = observationSchema.parse(normalizeObservationPayload(observation({ left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 })));
  assert.deepEqual(parsed.candidates[0].box, { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 });
});

test('normalizes the tracked target box', () => {
  const value = { ...observation({ left: 100, top: 200, right: 900, bottom: 800 }), candidates: [], targetMatch: 'matched', targetBox: { left: 250, top: 100, right: 750, bottom: 900 }, targetScale: 'large' };
  const parsed = observationSchema.parse(normalizeObservationPayload(value));
  assert.deepEqual(parsed.targetBox, { left: .25, top: .1, right: .75, bottom: .9 });
});

test('rejects out-of-range bounding boxes after normalization', () => {
  assert.throws(() => observationSchema.parse(normalizeObservationPayload(observation({ left: 0, top: 0, right: 1200, bottom: 800 }))));
});
