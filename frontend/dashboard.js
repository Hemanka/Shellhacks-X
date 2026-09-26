const debug = {
  events: [], frameTimes: [], resultTimes: [], lastResult: null, lastMask: null,
  lastFrameAt: 0, pairing: false,
};
const debugElement = id => document.getElementById(id);
function debugText(id, value) { const element = debugElement(id); if (element) element.textContent = value; }
function debugEvent(kind, data = {}) {
  debug.events.unshift({ time: new Date().toISOString(), kind, ...data });
  debug.events.length = Math.min(debug.events.length, 100);
  const list = debugElement('event-log'); list.replaceChildren();
  for (const entry of debug.events.slice(0, 30)) {
    const row = document.createElement('li');
    const time = document.createElement('time'); time.textContent = new Date(entry.time).toLocaleTimeString();
    const text = document.createElement('span'); text.textContent = `${entry.kind} · ${JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => !['time', 'kind'].includes(key))))}`;
    row.append(time, text); list.append(row);
  }
  if (kind === 'speech input') debugText('speech-input', data.transcript);
  if (kind === 'speech output') debugText('speech-output', data.text);
  if (kind.includes('error')) debugText('last-error', data.message || data.detail || kind);
}
function tickRate(samples, now) {
  samples.push(now);
  while (samples.length && samples[0] < now - 5000) samples.shift();
  return samples.length > 1 ? ((samples.length - 1) * 1000 / Math.max(1, now - samples[0])).toFixed(1) : '—';
}
window.WayfinderDashboard = {
  event: debugEvent,
  instruction(title, context) { debugText('instruction', title); debugText('instruction-sub', context); },
  result(result) {
    debug.lastResult = result;
    debugText('analysis-rate', tickRate(debug.resultTimes, Date.now()));
    debugText('gemini-ms', `${Math.round(result.timings?.gemini_ms || 0)} ms`);
    debugText('cycle-ms', `${Math.round(result.timings?.total_ms || 0)} ms`);
    debugText('capture-ms', `${Math.round(result.timings?.capture_ms || 0)} ms`);
    debugText('decision-ms', `${(result.timings?.decision_ms || 0).toFixed(2)} ms`);
    debugText('active-model', result.model || result.source || '—');
    debugText('decision-action', result.decision?.action || '—');
    debugText('decision-reason', result.decision?.reason || '—');
    debugText('candidate-scores', JSON.stringify(result.decision?.candidateScores || {}, null, 2));
    debugText('raw-result', JSON.stringify(result, null, 2));
    for (const side of ['left', 'center', 'right']) {
      const sector = result.perception?.sectors?.[side];
      debugText(`sector-${side}`, sector ? `${sector.status} · ${Math.round(sector.confidence * 100)}%` : '—');
      debugElement(`sector-${side}`).dataset.status = sector?.status || 'UNCERTAIN';
    }
    if (result.perception_error) debugText('last-error', result.perception_error);
  },
  mask(result) {
    debug.lastMask = { ...result, overlayDataUrl: '[image omitted]' };
    debugText('mask-ms', `${Math.round(result.totalMs)} ms`);
    debugText('raw-mask', JSON.stringify(debug.lastMask, null, 2));
  },
  loop(current) {
    debugText('request-state', current.analyzing ? 'Analyzing' : current.running ? 'Ready for next frame' : 'Paused');
    const remaining = Math.max(0, current.backoffUntil - Date.now());
    debugText('cooldown', remaining ? `${Math.ceil(remaining / 1000)} s` : 'None');
  },
};

function publishSession() { sendToPhone({ type: 'session_state', running: state.running, target: targetInput.value }); }
function phoneDisconnected() {
  state.revision += 1; state.remoteFrame = null; state.cameraActive = false;
  state.listening = false; debugText('phone-state', 'Disconnected');
  debugText('camera-permission', 'Disconnected'); debugText('mic-permission', 'Disconnected');
  if (state.running) startSession();
  debugText('connection-label', 'PHONE DISCONNECTED');
}
async function pairPhoneCamera() {
  if (debug.pairing) return;
  debug.pairing = true;
  try {
    if (state.running) await startSession();
    const publicUrl = debugElement('phone-base-url').value.trim();
    const response = await fetch('/api/pairing', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publicUrl ? { public_url: publicUrl } : {}),
    });
    const pairing = await response.json();
    if (!response.ok) throw new Error(pairing.detail || 'Could not create phone pairing');
    const previous = state.remoteSocket;
    state.remoteSocket = null; previous?.close();
    phoneDisconnected();
    debugElement('pairing-qr').src = pairing.qr_data_url;
    debugElement('phone-link').href = pairing.mobile_url;
    debugText('phone-link', pairing.mobile_url);
    debugText('pairing-hint', pairing.secure ? 'Scan, allow camera and microphone, then speak on the phone.' : 'HTTPS is required for phone permissions. Start with a tunnel or enter its HTTPS address above.');
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${location.host}/ws/pair/${pairing.session_id}?role=pc`);
    state.remoteSocket = socket;
    socket.onopen = () => { debugText('phone-state', 'Waiting for phone'); debugEvent('pairing ready'); };
    socket.onmessage = async event => {
      if (state.remoteSocket !== socket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'frame') {
          const now = Date.now(); state.remoteFrame = message.image_base64;
          state.remoteFrameId++; state.remoteFrameAt = now; debug.lastFrameAt = now;
          state.cameraActive = true;
          debugElement('remote-camera-frame').src = message.image_base64;
          debugElement('remote-camera-frame').classList.add('active');
          debugElement('camera-placeholder').classList.add('hidden');
          debugText('camera-rate', tickRate(debug.frameTimes, now));
          debugText('connection-label', 'PHONE CAMERA LIVE');
        } else if (message.type === 'peer_status') {
          if (message.connected) { debugText('phone-state', 'Connected'); publishSession(); }
          else phoneDisconnected();
          debugEvent('phone connection', { connected: message.connected });
        } else if (message.type === 'transcript') {
          await useTranscript(message.text); publishSession();
        } else if (message.type === 'listening') {
          state.listening = message.active; state.revision++;
          debugText('mic-permission', message.active ? 'Recording / transcribing' : 'Allowed');
          if (message.active) stopSpeaking();
        } else if (message.type === 'phone_status') {
          if (message.camera) debugText('camera-permission', message.camera);
          if (message.microphone) debugText('mic-permission', message.microphone);
            if (message.speech) debugText('speech-state', message.speech);
            if (message.speech === 'fallback' || message.speech === 'blocked') debugEvent('speech error', { detail: message.detail });
          debugEvent('phone status', message);
        } else if (message.type === 'control') {
          if ((message.action === 'pause' && state.running) || (message.action === 'resume' && !state.running)) await startSession();
          publishSession();
        }
      } catch (error) { debugEvent('phone error', { message: error.message }); }
    };
    socket.onclose = () => { if (state.remoteSocket === socket) { phoneDisconnected(); debugEvent('pairing error', { message: 'Pairing connection closed. Generate a new QR code to reconnect.' }); } };
  } finally { debug.pairing = false; }
}
debugElement('pair-button').addEventListener('click', () => pairPhoneCamera().catch(error => debugEvent('pairing error', { message: error.message })));
debugElement('target-form').addEventListener('submit', event => {
  event.preventDefault(); useTranscript(debugElement('manual-target').value).catch(error => debugEvent('target error', { message: error.message }));
});
debugElement('clear-events').addEventListener('click', () => { debug.events = []; debugElement('event-log').replaceChildren(); });
debugElement('export-debug').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), result: debug.lastResult, mask: debug.lastMask, events: debug.events }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = 'wayfinder-debug.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function checkServices() {
  try {
    const response = await fetch('/api/health'); if (!response.ok) throw new Error(`Server ${response.status}`);
    const health = await response.json();
    debugText('gemini-state', health.gemini_configured ? 'Configured' : 'API key missing');
    debugText('elevenlabs-state', health.elevenlabs_configured ? 'Configured' : 'API key missing');
    debugText('server-state', health.demo_mode ? 'Demo mode' : 'Connected');
  } catch (error) { debugText('server-state', 'Unavailable'); debugEvent('server error', { message: error.message }); }
}
setInterval(() => {
  window.WayfinderDashboard.loop(state);
  debugText('frame-age', debug.lastFrameAt ? `${((Date.now() - debug.lastFrameAt) / 1000).toFixed(1)} s` : '—');
  if (debug.lastFrameAt && Date.now() - debug.lastFrameAt > 2000) {
    debugText('camera-rate', '0');
    if (state.running) {
      startSession();
      setInstruction('Stop. Camera frames stopped.', 'Check the phone camera, then resume.');
      debugEvent('camera error', { message: 'No new phone frame for two seconds; guidance paused.' });
    }
  }
  if (debug.resultTimes.length && Date.now() - debug.resultTimes.at(-1) > 5000) debugText('analysis-rate', '0');
}, 500);
checkServices(); setInterval(checkServices, 15000);
pairPhoneCamera().catch(error => debugEvent('pairing error', { message: error.message }));
