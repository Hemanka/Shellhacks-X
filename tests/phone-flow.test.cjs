const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../frontend/mobile.js'), 'utf8');

function phoneHarness(modern = false) {
  const elements = new Map(), sent = [], spoken = [], timers = [], requests = [];
  let socket, recorder, permissions = 0;
  const tracks = [{ readyState: 'live', stop() {} }, { readyState: 'live', stop() {} }];
  const stream = { getTracks: () => tracks, getVideoTracks: () => [tracks[0]], getAudioTracks: () => [tracks[1]] };
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      callbacks: {}, classList: { add() {}, remove() {} }, textContent: '', disabled: false,
      addEventListener(event, callback) { this.callbacks[event] = callback; },
      videoWidth: 640, videoHeight: 480, play: async () => {},
      getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,test',
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    URLSearchParams, location: { search: '?session=test', protocol: 'https:', host: 'phone.example' },
    window: { isSecureContext: true, MediaRecorder: true, addEventListener() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { permissions++; return stream; } } },
    document: { getElementById: element, createElement: element },
    SeekRSpeech: class { stop() {} unlock() {} speak(text) { spoken.push(text); } },
    WebSocket: class { static OPEN = 1; readyState = 1; bufferedAmount = 0;
      constructor() { socket = this; } send(text) { sent.push(JSON.parse(text)); } close() {} },
    MediaStream: class {},
    MediaRecorder: class {
      static isTypeSupported() { return true; }
      mimeType = 'audio/webm'; state = 'inactive';
      constructor() { recorder = this; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['audio']) }); return this.onstop(); }
    },
    Blob, FormData, performance,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ text: 'Find my keys' }) }; },
    setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    setTimeout() {}, clearTimeout() {},
  });
  if(modern) vm.runInContext(fs.readFileSync(path.join(__dirname,'../frontend/feedback.js'),'utf8'),context);
  vm.runInContext(source + '\nglobalThis.phoneState = phone;', context);
  return {
    elements, sent, spoken, timers, requests, state: context.phoneState,
    permissions: () => permissions,
    socket: () => socket,
    message(message) { socket.onmessage({ data: JSON.stringify(message) }); },
    click: id => element(id).callbacks.click(),
    finishRecording: () => recorder.stop(),
  };
}

test('permissions are requested only by the phone permission button', async () => {
  const h = phoneHarness(); assert.equal(h.permissions(), 0);
  h.message({ type: 'peer_status', connected: true });
  await h.click('allow-permissions');
  assert.equal(h.permissions(), 1);
  assert.equal(h.elements.get('record-command').disabled, false);
  assert.ok(h.sent.some(event => event.type === 'phone_status' && event.camera === 'allowed' && event.microphone === 'allowed'));
});

test('phone camera sends at five fps and skips congested sockets', async () => {
  const h = phoneHarness(); h.message({ type: 'peer_status', connected: true });
  await h.click('allow-permissions');
  const timer = h.timers.at(-1); assert.equal(timer.ms, 200);
  h.socket().bufferedAmount = 1; timer.fn();
  assert.equal(h.sent.filter(event => event.type === 'frame').length, 0);
  h.socket().bufferedAmount = 0; timer.fn();
  assert.equal(h.sent.filter(event => event.type === 'frame').length, 1);
});

test('phone voice input is transcribed and forwarded to its dashboard', async () => {
  const h = phoneHarness(); h.message({ type: 'peer_status', connected: true });
  await h.click('allow-permissions'); await h.click('record-command');
  assert.ok(h.sent.some(event => event.type === 'listening' && event.active));
  await h.finishRecording();
  assert.equal(h.requests[0].url, '/api/transcribe');
  assert.ok(h.sent.some(event => event.type === 'transcript' && event.text === 'Find my keys'));
  assert.equal(h.elements.get('transcript').textContent, 'Find my keys');
  assert.equal(h.state.listening, false);
});

test('guidance plays on phone, repeats on demand, and stays quiet during recording', async () => {
  const h = phoneHarness(); h.message({ type: 'peer_status', connected: true });
  await h.click('allow-permissions');
  h.message({ type: 'guidance', text: 'Turn left, then stop.' });
  assert.equal(h.elements.get('spoken-output').textContent, 'Turn left, then stop.');
  h.click('repeat-guidance'); assert.equal(h.spoken.length, 2);
  h.state.listening = true;
  h.message({ type: 'guidance', text: 'An obsolete instruction' });
  assert.equal(h.spoken.length, 2);
});

test('dashboard loss stops guidance and disables voice input', async () => {
  const h = phoneHarness(); h.message({ type: 'peer_status', connected: true });
  await h.click('allow-permissions');
  h.message({ type: 'peer_status', connected: false });
  assert.equal(h.state.running, false);
  assert.equal(h.elements.get('record-command').disabled, true);
  assert.equal(h.spoken.at(-1), 'Stop. The computer disconnected. Hold your position.');
});

test('phone pause control requests a dashboard pause', () => {
  const h = phoneHarness(); h.state.running = true;
  h.click('pause-guidance');
  assert.ok(h.sent.some(event => event.type === 'control' && event.action === 'pause'));
});


test('a modern hazard cancels recording and its transcript, then speaks the named warning',async()=>{
  const h=phoneHarness(true);h.message({type:'peer_status',connected:true});await h.click('allow-permissions');
  h.message({type:'session_state',running:true,revision:2,target:'bottle'});
  await h.click('record-command');
  h.message({type:'hazard',id:'2:1',revision:2,stream:h.state.streamId,expiresAt:performance.now()+3000,
    priority:0,key:'chair',stage:'HOLD',text:'Stop—chair directly ahead.'});
  await Promise.resolve();
  assert.equal(h.state.listening,false);
  assert.ok(h.spoken.includes('Stop—chair directly ahead.'));
  assert.equal(h.requests.filter(x=>x.url==='/api/transcribe').length,0);
  assert.ok(h.sent.some(x=>x.type==='phone_status' && x.haptics==='tone fallback'));
});
