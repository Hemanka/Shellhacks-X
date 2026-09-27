const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function dashboardHarness(modern = false) {
  const elements = new Map(), outbound = [], requests = [], requestLog = [];
  let socket; const intervals=[];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', dataset: {}, style: {}, callbacks: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.callbacks[name] = callback; },
      replaceChildren() {}, append() {}, querySelector: () => null,
      getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,test',
    });
    return elements.get(id);
  }
  const scene = {
    frame_id: 'test', heading_deg: 0, candidates: [], source: 'test', model: 'test-model',
    perception: { target: { visible: true, direction: 'RIGHT' }, obstacles: [], sectors: {
      left: { status: 'OPEN', confidence: .9 }, center: { status: 'BLOCKED', confidence: .9 }, right: { status: 'OPEN', confidence: .9 },
    } },
    decision: { action: 'TURN_RIGHT', reason: 'Obstacle ahead', confidence: .9, candidateScores: { TURN_RIGHT: 12 } },
    guidance: { instruction: 'Turn right, then stop.', context: 'Obstacle ahead.', spokenText: 'Obstacle ahead. Turn right, then stop.', announcementKey: 'TURN_RIGHT:detour' },
    timings: { gemini_ms: 200, capture_ms: 2, decision_ms: .2, total_ms: 210 },
  };
  if(modern) {
    scene.perception.target={visible:true,label:'bottle',direction:'CENTER',confidence:.95,bbox:[.4,.4,.6,.8],support:'floor',pickupSuitable:true};
    scene.perception.access={approach:'clear',reach:'clear',reachability:'needs_approach',evidence:'Open approach'};
  }
  const context = vm.createContext({
    document: { getElementById: element, createElement: id => ({ ...element(id), callbacks: {} }) },
    window: {}, Date, performance, console: { info() {}, warn() {} },
    location: { protocol: 'http:', host: '127.0.0.1:8000' },
    Image: class { naturalWidth = 640; naturalHeight = 480; set src(value) { this.onload(); } },
    WebSocket: class { static OPEN = 1; readyState = 1;
      constructor() { socket = this; } send(text) { outbound.push(JSON.parse(text)); } close() {} },
    fetch: async (url, options) => {
      requests.push(url);
      requestLog.push({ url, options });
      const payload = url === '/api/pairing' ? { session_id: 'test', secure: true, qr_data_url: 'qr', mobile_url: 'https://phone.example/mobile.html?session=test' }
        : url === '/api/health' ? { gemini_configured: true, elevenlabs_configured: true }
          : url === '/api/traversability-route' ? { pathPlan: { routes: [{ direction: 'CENTER', action: 'FORWARD', points: [[.5,.95],[.5,.6]] }] }, maskSignature: [[1]], width: 128, height: 96, frame_meta: JSON.parse(options.body).frame_meta }
          : url === '/api/traversability-frame' ? { overlayDataUrl: 'mask', totalMs: 250, inferenceMs: 200, percentages: {}, pathPlan:{routes:[{direction:'CENTER',action:'FORWARD'}]} } : scene;
      if(modern && ['/api/analyze-frame','/api/traversability-frame'].includes(url)) payload.frame_meta=JSON.parse(options.body).frame_meta;
      return { ok: true, json: async () => payload };
    },
    setInterval: (fn,ms) => {intervals.push({fn,ms});return intervals.length;}, clearInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  for (const file of [...(modern?['navigation-controller.js']:[]),'app.js', 'dashboard.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend', file), 'utf8'), context);
  vm.runInContext('globalThis.sessionState = state;', context);
  await new Promise(setImmediate);
  socket.onopen();
  return { elements, outbound, requests, requestLog, context, intervals, state: context.sessionState,
    message: message => socket.onmessage({ data: JSON.stringify(message) }),
  };
}

test('phone transcript drives analysis, dashboard diagnostics, and a phone speech instruction', async () => {
  const h = await dashboardHarness();
  await h.message({ type: 'peer_status', connected: true });
  await h.message({ type: 'frame', image_base64: 'data:image/jpeg;base64,test' });
  await h.message({ type: 'transcript', text: 'Find the exit' });
  assert.equal(h.state.running, true);
  assert.equal(h.elements.get('target-display').textContent, 'exit');
  assert.equal(h.elements.get('gemini-ms').textContent, '200 ms');
  assert.equal(h.elements.get('sector-center').textContent, 'BLOCKED · 90%');
  assert.equal(h.elements.get('speech-input').textContent, 'Find the exit');
  assert.ok(h.outbound.some(message => message.type === 'guidance' && message.text === 'Obstacle ahead. Turn right, then stop.'));
  assert.ok(!h.requests.includes('/api/speech'), 'the Windows dashboard must not request or play speech itself');
  assert.equal(JSON.parse(h.elements.get('raw-result').textContent).model, 'test-model');
});

test('phone disconnect pauses a running dashboard and invalidates its camera frame', async () => {
  const h = await dashboardHarness();
  await h.message({ type: 'frame', image_base64: 'data:image/jpeg;base64,test' });
  await h.message({ type: 'transcript', text: 'Find the exit' });
  await h.message({ type: 'peer_status', connected: false });
  assert.equal(h.state.running, false);
  assert.equal(h.state.remoteFrame, null);
  assert.equal(h.elements.get('phone-state').textContent, 'Disconnected');
});


test('current dashboard sends frame-linked expiring instructions with the session revision',async()=>{
  const h=await dashboardHarness(true);
  await h.message({type:'peer_status',connected:true});
  const meta={stream:'phone',seq:1,capturedAt:performance.now(),orientation:null};
  await h.message({type:'frame',image_base64:'data:image/jpeg;base64,test',meta});
  await h.message({type:'transcript',text:'Find bottle'});
  await new Promise(setImmediate);
  const routeRequest=h.requestLog.find(call=>call.url==='/api/traversability-route');
  assert.ok(routeRequest);
  assert.deepEqual(JSON.parse(routeRequest.options.body).frame_meta,meta);
  assert.equal(JSON.parse(routeRequest.options.body).perception.target.label,'bottle');
  const cue=h.outbound.find(x=>x.id && x.stage==='APPROACH');
  assert.ok(cue);assert.equal(cue.evidenceFrame,1);assert.equal(cue.stream,'phone');
  assert.equal(cue.expiresAt,null);
  assert.ok(h.outbound.some(x=>x.type==='session_state' && x.revision===cue.revision));
  assert.match(h.elements.get('controller-summary').textContent,/APPROACH/);
});

test('brief camera gap does not pause; long gap recovers automatically',async()=>{
 const h=await dashboardHarness(true);
 await h.message({type:'frame',image_base64:'data:image/jpeg;base64,test',meta:{stream:'phone',seq:1,capturedAt:performance.now()}});
 await h.message({type:'transcript',text:'Find bottle'});
 vm.runInContext('debug.lastFrameAt = Date.now()-2500',h.context);
 h.intervals.find(x=>x.ms===500).fn();assert.equal(h.state.running,true);
 assert.ok(!h.outbound.some(x=>x.text?.includes('reconnect')));
 vm.runInContext('debug.lastFrameAt = Date.now()-11000',h.context);
 h.intervals.find(x=>x.ms===500).fn();h.intervals.find(x=>x.ms===500).fn();
 assert.equal(h.state.running,true);
 assert.equal(h.outbound.filter(x=>x.text?.includes('Waiting for the camera')).length,1);
 await h.message({type:'frame',image_base64:'data:image/jpeg;base64,test',meta:{stream:'phone',seq:2,capturedAt:performance.now()}});
 assert.equal(vm.runInContext('debug.cameraInterrupted',h.context),false);
 assert.equal(h.state.running,true);
});
