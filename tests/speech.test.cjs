const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness() {
  const reports = [], fallback = [], players = []; let requests = 0;
  const controls = { status: 200, error: null };
  const context = { window: { speechSynthesis: { cancel() {}, speak(u) { fallback.push(u); } } },
    Audio: class { constructor() { players.push(this); } pause() {} async play() { if (controls.error) throw controls.error; } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    AbortController, Blob, Uint8Array, DataView, performance,
    fetch: async () => { requests++; return { ok: controls.status === 200, status: controls.status, blob: async () => new Blob(['audio']) }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../frontend/speech.js'), 'utf8'), context);
  return { speech: new context.window.WayfinderSpeech((...report) => reports.push(report)), reports, fallback, players, controls, requests: () => requests };
}
test('ElevenLabs clips reuse the player and cache repeated instructions', async () => {
  const h = harness(); h.speech.unlock();
  await h.speech.speak('Scan the room'); await h.speech.speak('Scan the room');
  assert.equal(h.players.length, 1); assert.equal(h.requests(), 1); assert.equal(h.fallback.length, 0);
});
test('autoplay denial retains ElevenLabs audio for user retry without changing voices', async () => {
  const h = harness(); h.controls.error = Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' });
  await h.speech.speak('Scan the room');
  assert.equal(h.fallback.length, 0); assert.equal(h.reports.at(-1)[0], 'blocked');
  assert.match(h.reports.at(-1)[1], /playback.*NotAllowedError/);
  h.controls.error = null; await h.speech.speak('Scan the room');
  assert.equal(h.requests(), 1); assert.equal(h.reports.at(-1)[0], 'playing');
});
test('service failure preserves emergency fallback and reports its cause', async () => {
  const h = harness(); h.controls.status = 502; await h.speech.speak('Stop');
  assert.equal(h.fallback.length, 1);
  assert.ok(h.reports.some(([state, detail]) => state === 'fallback' && detail.includes('HTTP 502')));
});
test('decoder failure is distinguished from service failure', async () => {
  const h = harness(); h.controls.error = Object.assign(new Error('Unsupported audio'), { name: 'NotSupportedError' });
  await h.speech.speak('Stop');
  assert.ok(h.reports.some(([state, detail]) => state === 'fallback' && detail.includes('playback: NotSupportedError')));
});
