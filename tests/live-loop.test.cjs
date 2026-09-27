const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  let now = 10000;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: 'keys', textContent: '', style: {},
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, videoWidth: 1280, videoHeight: 720,
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => 'data:image/jpeg;base64,frame',
    });
    return elements.get(id);
  };
  const requests = [];
  const intervals = [];
  const decisions = [];
  const instructions = [];
  const context = vm.createContext({
    document: { getElementById: element, createElement: element },
    window: {}, navigator: {}, WebSocket: { OPEN: 1 }, console: { info() {}, warn() {} },
    Date: class extends Date { static now() { return now; } },
    performance: { now: () => now },
    Image: class {
      naturalWidth = 1280; naturalHeight = 720;
      set src(value) { this.onload(); }
    },
    fetch(url, options) {
      const pending = deferred();
      requests.push({ url, options, ...pending });
      return pending.promise;
    },
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval() {}, setTimeout() {}, clearTimeout() {},
    decisions,
    instructions,
  });
  vm.runInContext(source + `
    const presentDecision = applyNavigationDecision;
    connectCamera = async () => true;
    addSightings = () => {};
    applyNavigationDecision = result => decisions.push(result);
    renderTraversability = () => {};
    setInstruction = (...args) => instructions.push(args);
    state.running = true; state.cameraActive = true; state.stream = {};
    globalThis.loop = { state, analyzeFrame, startSession, setTarget, presentDecision };
  `, context);
  return { ...context.loop, requests, intervals, decisions, instructions,
    advance(ms) { now += ms; },
    navigation() { return requests.filter(r => r.url === '/api/analyze-frame'); },
    masks() { return requests.filter(r => r.url === '/api/traversability-frame'); },
  };
}
const response = extra => ({ ok: true, json: async () => ({
  decision: { action: 'HOLD' }, heading_deg: 0, timings: {}, ...extra,
}) });

test('guidance completes without waiting for the mask; slow masks never pile up', async () => {
  const h = harness();
  const first = h.analyzeFrame();
  h.navigation()[0].resolve(response());
  await first;
  assert.equal(h.decisions.length, 1);
  assert.equal(h.state.maskAnalyzing, true);
  h.advance(1000);
  const second = h.analyzeFrame();
  h.navigation()[1].resolve(response());
  await second;
  assert.equal(h.decisions.length, 2);
  assert.equal(h.masks().length, 1);
});

test('slow navigation requests stay single-flight, then immediately allow fresh work', async () => {
  const h = harness();
  const first = h.analyzeFrame();
  h.advance(2000);
  await h.analyzeFrame();
  assert.equal(h.navigation().length, 1);
  h.navigation()[0].resolve(response());
  await first;
  const second = h.analyzeFrame();
  assert.equal(h.navigation().length, 2);
  h.navigation()[1].resolve(response());
  await second;
});

test('fast responses permit four analyses per second instead of a six-second timer', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    const pending = h.analyzeFrame();
    assert.equal(h.navigation().length, i + 1);
    h.advance(200);
    h.navigation()[i].resolve(response());
    await pending;
    await h.analyzeFrame();
    assert.equal(h.navigation().length, i + 1);
    h.advance(50);
  }
  assert.equal(h.decisions.length, 4);
});

test('quota cooldown blocks both automatic and direct analysis calls', async () => {
  const h = harness();
  const pending = h.analyzeFrame();
  h.navigation()[0].resolve(response({ rateLimited: true, retryAfterMs: 30000 }));
  await pending;
  h.advance(29999);
  await h.analyzeFrame();
  assert.equal(h.navigation().length, 1);
  assert.equal(h.decisions.length, 0);
  h.advance(1);
  const retry = h.analyzeFrame();
  h.navigation()[1].resolve(response());
  await retry;
});

for (const mode of ['pause', 'target change', 'voice input']) {
  test(`late response is ignored after ${mode}`, async () => {
    const h = harness();
    const pending = h.analyzeFrame();
    if (mode === 'pause') await h.startSession();
    if (mode === 'target change') h.setTarget('door');
    if (mode === 'voice input') h.state.listening = true;
    h.navigation()[0].resolve(response());
    await pending;
    assert.equal(h.decisions.length, 0);
    assert.equal(h.state.analyzing, false);
  });
}

test('network failures back off instead of hammering the server', async () => {
  const h = harness();
  const pending = h.analyzeFrame();
  h.navigation()[0].resolve({ ok: false, status: 503, json: async () => ({ detail: 'Unavailable' }) });
  await assert.rejects(pending, /Unavailable/);
  h.advance(500);
  await h.analyzeFrame();
  assert.equal(h.navigation().length, 1);
});

test('the same phone frame is never analyzed twice and stale frames are skipped', async () => {
  const h = harness();
  Object.assign(h.state, { remoteFrame: 'data:frame', remoteFrameId: 1, remoteFrameAt: 10000 });
  const first = h.analyzeFrame();
  await Promise.resolve();
  h.navigation()[0].resolve(response());
  await first;
  h.advance(250);
  await h.analyzeFrame();
  assert.equal(h.navigation().length, 1);
  h.state.remoteFrameId++;
  h.advance(2000);
  await h.analyzeFrame();
  assert.equal(h.navigation().length, 1);
});

test('session timer checks promptly rather than sleeping six seconds', async () => {
  const h = harness();
  h.state.running = false;
  const starting = h.startSession();
  await Promise.resolve();
  h.navigation()[0].resolve(response());
  await starting;
  assert.ok(h.intervals.some(timer => timer.ms === 50));
});

const guidedDecision = (action = 'TURN_RIGHT', mode = 'detour') => ({
  decision: { action, confidence: .9, voiceInstruction: 'Legacy instruction', reason: 'Diagnostic reason' },
  guidance: { instruction: 'Turn slightly right, then stop.', context: 'There is an obstacle ahead.',
    spokenText: 'Obstacle ahead. Turn slightly right, then stop.', announcementKey: `${action}:${mode}` },
});

test('structured guidance supplies the visible instruction and short spoken cue', () => {
  const h = harness();
  h.presentDecision(guidedDecision());
  assert.deepEqual(Array.from(h.instructions[0]), [
    'Turn slightly right, then stop.', 'There is an obstacle ahead.', .9, true,
    'Obstacle ahead. Turn slightly right, then stop.',
  ]);
});

test('repeated frames stay quiet but new obstacle context and stop actions announce immediately', () => {
  const h = harness();
  h.presentDecision(guidedDecision('TURN_RIGHT', 'align'));
  h.advance(250);
  h.presentDecision(guidedDecision('TURN_RIGHT', 'align'));
  h.presentDecision(guidedDecision('TURN_RIGHT', 'detour'));
  h.presentDecision(guidedDecision('HOLD', 'blocked'));
  assert.deepEqual(h.instructions.map(args => args[3]), [true, false, true, true]);
});

test('repeat reminder and new-target announcement are retained', () => {
  const h = harness();
  h.presentDecision(guidedDecision());
  h.advance(6000);
  h.presentDecision(guidedDecision());
  h.setTarget('door');
  h.presentDecision(guidedDecision());
  assert.deepEqual(h.instructions.map(args => args[3]), [true, true, true]);
});

test('older API responses retain basic spoken instruction support', () => {
  const h = harness();
  h.presentDecision({ decision: { action: 'HOLD', confidence: .5, voiceInstruction: 'Hold.', reason: 'Checking.' } });
  assert.deepEqual(Array.from(h.instructions[0]), ['Hold.', 'Checking.', .5, true, null]);
});

test('mask starts at up to two updates per second and never overlaps or queues stale frames', async () => {
  const h = harness();
  Object.assign(h.state, { remoteFrame: 'data:frame1', remoteFrameId: 1, remoteFrameAt: 10000, frameMeta: { stream: 's', seq: 1, capturedAt: 10000 } });
  const pending = h.analyzeFrame(); await Promise.resolve();
  assert.equal(h.masks().length, 1);
  h.navigation()[0].resolve(response()); await pending;

  h.advance(499);
  Object.assign(h.state, { remoteFrame: 'data:frame2', remoteFrameId: 2, remoteFrameAt: 10499, frameMeta: { stream: 's', seq: 2, capturedAt: 10499 } });
  const second = h.analyzeFrame(); await Promise.resolve();
  h.navigation()[1].resolve(response()); await second;
  assert.equal(h.masks().length, 1, 'the in-flight mask prevents an overlapping request');

  h.masks()[0].resolve(response()); await new Promise(resolve => setImmediate(resolve));
  Object.assign(h.state, { remoteFrame: 'data:frame3', remoteFrameId: 3, remoteFrameAt: 10499, frameMeta: { stream: 's', seq: 3, capturedAt: 10499 } });
  h.state.nextScanAt = 0;
  const third = h.analyzeFrame(); await Promise.resolve();
  h.navigation()[2].resolve(response()); await third;
  assert.equal(h.masks().length, 1, 'the 500 ms cadence is enforced');

  h.advance(1);
  Object.assign(h.state, { remoteFrame: 'data:frame4', remoteFrameId: 4, remoteFrameAt: 10500, frameMeta: { stream: 's', seq: 4, capturedAt: 10500 } });
  h.state.nextScanAt = 0;
  const fourth = h.analyzeFrame(); await Promise.resolve();
  assert.equal(h.masks().length, 2);
  assert.equal(JSON.parse(h.masks()[1].options.body).frame_meta.seq, 4, 'the freshest frame is segmented; skipped frames are not queued');
  h.navigation()[3].resolve(response()); await fourth;
  h.masks()[1].resolve(response()); await new Promise(resolve => setImmediate(resolve));
});
