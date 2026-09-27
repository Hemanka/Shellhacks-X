const phone = {
  socket: null, stream: null, frameTimer: null, dashboard: false, running: false,
  listening: false, lastGuidance: '', connecting: false, handsFree: false,
  recognizer: null, recognizerStarting: false, speechSuspended: false,
  transcriber: 'detecting', elevenLabsConfigured: false,
  awaitingResponse: false, awaitingInitialItem: false, hasTarget: false,
  wakeArmedUntil: 0, recorder: null, audioContext: null, analyser: null,
  audioFrame: 0, audioInspect: null, transcribing: false,
  silenceTimer: null, voiceChunks: [], speechStartedAt: 0,
};
const el = id => document.getElementById(id);
const phoneVideo = el('phone-video');
const captureCanvas = document.createElement('canvas');
const pairSession = new URLSearchParams(location.search).get('session');
function sendPhone(message) {
  if (phone.socket?.readyState === WebSocket.OPEN) phone.socket.send(JSON.stringify(message));
}
function setStatus(text) { el('status').textContent = text; }
function displayTarget(target) {
  el('target-value').textContent = String(target || '').trim() || 'Waiting for an item';
}
function browserRecognitionAvailable() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
function updateListeningStatus(text = `${phone.transcriber === 'elevenlabs' ? 'ElevenLabs Scribe' : phone.transcriber === 'browser' ? 'Browser speech recognition' : 'Mic'} is on. ${phone.hasTarget ? 'Say “Hey SeekR” and your request, or answer a question.' : 'Say an item, like “red cup” or “black hoodie.”'}`) {
  el('voice-status').textContent = text;
}
async function selectTranscriber() {
  phone.transcriber = 'detecting';
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Health check returned ${response.status}`);
    const health = await response.json();
    phone.elevenLabsConfigured = Boolean(health.elevenlabs_configured);
  } catch {
    phone.elevenLabsConfigured = false;
  }
  phone.transcriber = phone.elevenLabsConfigured ? 'elevenlabs'
    : browserRecognitionAvailable() ? 'browser' : 'unavailable';
  sendPhone({ type: 'phone_status', transcriber: phone.transcriber,
    detail: phone.transcriber === 'elevenlabs' ? 'ElevenLabs Scribe selected' :
      phone.transcriber === 'browser' ? 'Browser speech recognition selected; ElevenLabs is not configured' :
        'No speech recognition provider is available' });
}
function setDashboardListening(active) {
  if (phone.listening === active) return;
  phone.listening = active;
  sendPhone({ type: 'listening', active });
}
const speech = new SeekRSpeech((state, detail) => {
  sendPhone({ type: 'phone_status', speech: state, detail });
  if (state === 'blocked') setStatus('Audio could not start. Check your phone’s audio settings.');
  else if (state === 'fallback') setStatus(detail);
  if (state === 'requesting' || state === 'playing') suspendRecognition();
  if (state === 'idle' || state === 'expired' || state === 'blocked') resumeRecognition();
});
phone.streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
phone.frameSeq = 0; phone.revision = 0;
const orientation = window.PhoneOrientation ? new window.PhoneOrientation(detail => sendPhone({type:'phone_status',orientation:detail})) : null;
const feedback = window.PhoneFeedback ? new window.PhoneFeedback(speech,
  (kind,detail)=>sendPhone({type:'phone_status',...(kind==='haptics'?{haptics:detail}:{}),detail}),
  cue=>{phone.lastGuidance=cue.text;el('spoken-output').textContent=cue.text;phone.awaitingResponse=expectsResponse(cue);},
  ()=>{ setDashboardListening(false); }
) : null;
setInterval(()=>{
  const sample=orientation?.current();
  if(sample && phone.dashboard && phone.socket?.bufferedAmount===0) sendPhone({type:'orientation',stream:phone.streamId,orientation:sample});
},100);
function expectsResponse(cue) {
  const text = String(cue?.text || '');
  return cue?.type === 'PICKUP' || /\?|say (yes|no|got it|lost it|too far)|tell me|what would you like/i.test(text);
}
function reportPermissions() {
  sendPhone({ type: 'phone_status',
    camera: phone.stream?.getVideoTracks().some(track => track.readyState === 'live') ? 'allowed' : 'not ready',
    microphone: phone.stream?.getAudioTracks().some(track => track.readyState === 'live') ? 'allowed' : 'not ready',
  });
}
function setPhoneReady() {
  const ready = phone.dashboard && !!phone.stream;
  if (ready && phone.handsFree) setStatus('Connected. Camera and microphone are on.');
  else if (phone.stream && !phone.dashboard) setStatus('Camera and microphone are ready. Waiting for the computer.');
}
function stopRecognition() {
  if (phone.recognizer) {
    const recognizer = phone.recognizer; phone.recognizer = null;
    recognizer.onend = null; recognizer.onerror = null; recognizer.onresult = null;
    try { recognizer.abort(); } catch {}
  }
  phone.recognizerStarting = false;
}
function stopFallbackCapture() {
  cancelAnimationFrame(phone.audioFrame); phone.audioFrame = 0;
  clearTimeout(phone.silenceTimer); phone.silenceTimer = null;
  if (phone.recorder?.state === 'recording') {
    phone.recorder.__cancelled = true;
    try { phone.recorder.stop(); } catch {}
  }
  phone.recorder = null; phone.voiceChunks = [];
  phone.audioContext?.close().catch(()=>{}); phone.audioContext = null; phone.analyser = null; phone.audioInspect = null;
}
function stopPhoneInput() {
  phone.handsFree = false; stopRecognition(); stopFallbackCapture();
  feedback?.cancel(); clearInterval(phone.frameTimer); phone.frameTimer = null;
  setDashboardListening(false); phone.awaitingResponse = false; speech.stop();
}
function connectPhone() {
  if (!pairSession) { setStatus('Scan the QR code on the computer to connect.'); return; }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/pair/${pairSession}?role=mobile`);
  phone.socket = socket;
  socket.onopen = reportPermissions;
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'peer_status') {
      phone.dashboard = message.connected;
      if (!phone.dashboard) {
        phone.running = false; phone.awaitingResponse = false;
        setStatus('Computer disconnected. Hold your position.');
        el('spoken-output').textContent = 'Stop. Hold your position.';
        speech.speak('Stop. The computer disconnected. Hold your position.');
      } else if (phone.stream) {
        clearInterval(phone.frameTimer); phone.frameTimer = setInterval(sendFrame, 200);
        if (phone.handsFree) startHandsFree();
      }
      setPhoneReady(); reportPermissions();
    } else if ((message.type === 'hazard' || message.type === 'guidance') && message.id && feedback) {
      if (!phone.listening) feedback.accept(message);
    } else if (message.type === 'cancel_hazard') {
      try { navigator.vibrate?.(0); } catch {}
    } else if (message.type === 'guidance') {
      if (phone.listening) return;
      phone.lastGuidance = message.text; el('spoken-output').textContent = message.text;
      if (/tell me an item to find/i.test(message.text)) phone.awaitingInitialItem = true;
      phone.awaitingResponse = expectsResponse(message);
      speech.speak(message.text);
    } else if (message.type === 'stop_speech') {
      feedback?.cancel(); speech.stop(); phone.speechSuspended=false; resumeRecognition();
    } else if (message.type === 'session_state') {
      phone.running = message.running;
      phone.hasTarget = Boolean(message.target);
      displayTarget(message.target);
      if (phone.running || phone.hasTarget) phone.awaitingInitialItem = false;
      phone.revision = message.revision ?? phone.revision;
      feedback?.session(phone.revision,phone.streamId,phone.running);
      phone.speechSuspended=false; resumeRecognition();
    }
  };
  socket.onclose = () => {
    if (phone.socket !== socket) return;
    phone.dashboard = false; phone.running = false;
    el('allow-permissions').hidden = false; el('allow-permissions').textContent = 'Reconnect SeekR';
    setStatus('Connection lost. Hold your position, then reconnect.');
    el('spoken-output').textContent = 'Stop. Hold your position.';
    speech.speak('Stop. Connection lost. Hold your position.');
  };
}
function sendFrame() {
  const socket = phone.socket;
  if (!phone.dashboard || !socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 0 || !phoneVideo.videoWidth) return;
  const scale = Math.min(1, 960 / Math.max(phoneVideo.videoWidth, phoneVideo.videoHeight));
  captureCanvas.width = Math.round(phoneVideo.videoWidth * scale);
  captureCanvas.height = Math.round(phoneVideo.videoHeight * scale);
  captureCanvas.getContext('2d').drawImage(phoneVideo, 0, 0, captureCanvas.width, captureCanvas.height);
  socket.send(JSON.stringify({ type: 'frame', image_base64: captureCanvas.toDataURL('image/jpeg', .65),
    meta:{stream:phone.streamId,seq:++phone.frameSeq,capturedAt:performance.now(),orientation:orientation?.current() || null} }));
}
function normalizeText(text) { return String(text || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function routeUtterance(raw) {
  const text = normalizeText(raw);
  if (!text) return;
  const wake = /\b(?:hey\s+)?(?:seek\s*r|seekr|seeker|see\s*qr)\b/;
  const match = text.match(wake);
  const remainder = match ? text.slice(match.index + match[0].length).trim() : '';
  const exitTask = /^(exit (the )?task|finish (the )?task|exit session|finish navigation|exit navigation|im done|i am done)$/.test(text);
  const command = /^(pause|stop|resume|continue|repeat|say that again|hear that again)$/.test(text) || exitTask;
  if (!match && !phone.awaitingResponse && !command && phone.hasTarget && !phone.awaitingInitialItem) return;
  if (exitTask && !match && Date.now() > phone.wakeArmedUntil) return;
  if (match && !remainder) {
    phone.wakeArmedUntil = Date.now() + 30000;
    phone.awaitingResponse = true;
    speech.speak('I’m listening. Tell me the item and any visual details, like a red cup or black hoodie.');
    updateListeningStatus('I’m listening. Name an item, such as a red cup or black hoodie.');
    return;
  }
  let transcript = match ? remainder : text;
  if (/^(say that again|hear that again)$/.test(transcript)) transcript='repeat';
  if (transcript==='stop') transcript='pause';
  if (/^(finish (the )?task|exit (the )?session|exit navigation|finish navigation|im done|i am done)$/.test(transcript)) transcript='exit task';
  if (/^(i )?(cant|cannot) reach it$/.test(transcript)) transcript='cannot reach it';
  if (/^(im|its|it is) too far$/.test(transcript)) transcript='too far';
  phone.awaitingResponse = false;
  phone.awaitingInitialItem = false;
  phone.wakeArmedUntil = 0;
  setDashboardListening(false);
  updateListeningStatus(`I heard: ${transcript}`);
  if (phone.dashboard) sendPhone({ type: 'transcript', text: transcript });
}
function suspendRecognition() {
  if (!phone.handsFree) return;
  phone.speechSuspended = true;
  stopRecognition();
  if (phone.recorder?.state === 'recording') { phone.recorder.__cancelled = true; try { phone.recorder.stop(); } catch {} }
}
function resumeRecognition() {
  if (!phone.handsFree || document.hidden) return;
  phone.speechSuspended = false;
  startHandsFree();
}
function startHandsFree() {
  if (!phone.handsFree || !phone.dashboard || phone.speechSuspended || document.hidden || phone.recognizer || phone.recognizerStarting || phone.transcriber === 'detecting') return;
  if (phone.transcriber === 'elevenlabs') { startElevenLabsListener(); return; }
  if (phone.transcriber === 'unavailable') {
    updateListeningStatus('Speech recognition is unavailable. Add an ElevenLabs key or use a browser with speech recognition.');
    return;
  }
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { phone.transcriber = 'unavailable'; startHandsFree(); return; }
  const recognizer = new Recognition(); phone.recognizer = recognizer; phone.recognizerStarting = true;
  recognizer.lang = navigator.language || 'en-US'; recognizer.continuous = true;
  recognizer.interimResults = true; recognizer.maxAlternatives = 1;
  let activeUtterance = '';
  recognizer.onstart = () => { phone.recognizerStarting = false; updateListeningStatus(); };
  recognizer.onresult = event => {
    if (phone.recognizer !== recognizer) return;
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const part = event.results[i]?.[0]?.transcript?.trim() || '';
      if (event.results[i].isFinal) activeUtterance += ` ${part}`;
      else interim += ` ${part}`;
    }
    if (interim.trim()) {
      setDashboardListening(true);
      updateListeningStatus('Listening…');
    }
    if (activeUtterance.trim()) {
      const finalText = activeUtterance.trim(); activeUtterance = '';
      setDashboardListening(false); routeUtterance(finalText);
    }
  };
  recognizer.onerror = event => {
    if (phone.recognizer !== recognizer) return;
    phone.recognizer = null; phone.recognizerStarting = false;
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      if (phone.elevenLabsConfigured) {
        phone.transcriber = 'elevenlabs';
        updateListeningStatus('Switching to ElevenLabs Scribe.');
        startElevenLabsListener();
      } else {
        phone.transcriber = 'unavailable';
        updateListeningStatus('Allow browser speech recognition, or configure ElevenLabs transcription.');
      }
      return;
    }
    setTimeout(startHandsFree, 500);
  };
  recognizer.onend = () => {
    if (phone.recognizer !== recognizer) return;
    phone.recognizer = null; phone.recognizerStarting = false;
    if (activeUtterance.trim()) { setDashboardListening(false); routeUtterance(activeUtterance); }
    if (phone.handsFree && !phone.speechSuspended) setTimeout(startHandsFree, 250);
  };
  try { recognizer.start(); } catch {
    phone.recognizer = null; phone.recognizerStarting = false;
    if (phone.elevenLabsConfigured) { phone.transcriber = 'elevenlabs'; startElevenLabsListener(); }
    else { phone.transcriber = 'unavailable'; startHandsFree(); }
  }
}
function startElevenLabsListener() {
  if (!phone.handsFree || !phone.dashboard || document.hidden || !phone.stream) return;
  if (!phone.elevenLabsConfigured) {
    phone.transcriber = browserRecognitionAvailable() ? 'browser' : 'unavailable';
    startHandsFree();
    return;
  }
  if (!window.MediaRecorder) {
    phone.transcriber = browserRecognitionAvailable() ? 'browser' : 'unavailable';
    startHandsFree();
    return;
  }
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    phone.transcriber = browserRecognitionAvailable() ? 'browser' : 'unavailable';
    startHandsFree();
    return;
  }
  if (phone.audioContext) {
    const restartInspection = () => {
      if (phone.handsFree && !document.hidden && phone.audioInspect && !phone.audioFrame) {
        phone.audioFrame = requestAnimationFrame(phone.audioInspect);
      }
    };
    if (phone.audioContext.state === 'suspended') void phone.audioContext.resume().then(restartInspection).catch(() => {});
    else restartInspection();
    return;
  }
  try {
    phone.audioContext = new AudioContext();
    const source = phone.audioContext.createMediaStreamSource(new MediaStream(phone.stream.getAudioTracks()));
    phone.analyser = phone.audioContext.createAnalyser(); phone.analyser.fftSize = 1024; source.connect(phone.analyser);
    const samples = new Uint8Array(phone.analyser.fftSize);
    const inspect = () => {
      if (!phone.handsFree || !phone.analyser || document.hidden) { phone.audioFrame = 0; return; }
      phone.analyser.getByteTimeDomainData(samples);
      let energy = 0; for (const sample of samples) { const v = (sample - 128) / 128; energy += v * v; }
      // Keep this animation loop alive while SeekR speaks. Only capture when
      // the mic is available for user input; exiting here used to strand the
      // ElevenLabs listener after the first spoken reply.
      const canCapture = !phone.speechSuspended && !speech.busy && !phone.transcribing;
      const voiced = canCapture && Math.sqrt(energy / samples.length) > 0.022;
      if (voiced && !phone.recorder) beginFallbackUtterance();
      if (phone.recorder?.state === 'recording') {
        if (voiced) { clearTimeout(phone.silenceTimer); phone.silenceTimer = null; }
        else if (!phone.silenceTimer) phone.silenceTimer = setTimeout(finishFallbackUtterance, 850);
      }
      phone.audioFrame = requestAnimationFrame(inspect);
    };
    phone.audioInspect = inspect;
    void phone.audioContext.resume().then(()=>{ if (phone.handsFree && !document.hidden && !phone.audioFrame) phone.audioFrame = requestAnimationFrame(inspect); });
  } catch { updateListeningStatus('Could not start hands-free listening in this browser.'); }
}
function beginFallbackUtterance() {
  try {
    const mime = ['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(type=>MediaRecorder.isTypeSupported(type));
    const recorder = phone.recorder = mime ? new MediaRecorder(new MediaStream(phone.stream.getAudioTracks()),{mimeType:mime}) : new MediaRecorder(new MediaStream(phone.stream.getAudioTracks()));
    phone.voiceChunks = []; phone.speechStartedAt = performance.now();
    recorder.ondataavailable = event=>{ if(event.data?.size) phone.voiceChunks.push(event.data); };
    recorder.onstop = ()=>{
      if (recorder.__cancelled || phone.recorder !== recorder) return;
      phone.recorder = null; setDashboardListening(false);
      const blob = new Blob(phone.voiceChunks,{type:recorder.mimeType || 'audio/webm'}); phone.voiceChunks=[];
      if (performance.now()-phone.speechStartedAt >= 350) void transcribeWithElevenLabs(blob);
    };
    recorder.start(); setDashboardListening(true); updateListeningStatus('Listening…');
  } catch { phone.recorder = null; }
}
function finishFallbackUtterance() { clearTimeout(phone.silenceTimer); phone.silenceTimer=null; if(phone.recorder?.state==='recording') phone.recorder.stop(); }
async function transcribeWithElevenLabs(blob) {
  if (phone.transcribing) return;
  phone.transcribing = true;
  try {
    const form = new FormData(); form.append('file',blob,`voice-command.${blob.type.includes('mp4')?'mp4':blob.type.includes('ogg')?'ogg':'webm'}`);
    const response = await fetch('/api/transcribe',{method:'POST',body:form});
    if(!response.ok) {
      let detail=''; try { detail=(await response.json()).detail || ''; } catch {}
      const error=new Error(detail || `Transcription failed (${response.status}).`); error.status=response.status; throw error;
    }
    const result = await response.json(); routeUtterance(result.text || '');
  } catch (error) {
    setDashboardListening(false);
    if (error.status === 422) { updateListeningStatus('I didn’t catch that. Please say it again.'); return; }
    // Keep the ElevenLabs listener alive and retry on the next spoken turn.
    // A transient network or quota error must not silently switch providers
    // and disable the expected wake-phrase path.
    updateListeningStatus(`ElevenLabs transcription failed. Keep listening and try again. ${error.message || ''}`.trim());
    sendPhone({type:'phone_status',transcriber:'elevenlabs',detail:error.message || 'ElevenLabs transcription failed; listener remains active'});
  } finally {
    phone.transcribing = false;
  }
}
el('allow-permissions').addEventListener('click', async () => {
  if (phone.connecting) return;
  if (!pairSession) { setStatus('Scan the QR code on the computer first.'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { setStatus('Open the secure phone link from the computer QR code to allow camera and microphone.'); return; }
  speech.unlock(); feedback?.unlock(); orientation?.enable(); phone.connecting=true;
  try {
    if (!phone.stream || phone.stream.getTracks().some(track=>track.readyState!=='live')) {
      phone.stream?.getTracks().forEach(track=>track.stop());
      phone.stream = await navigator.mediaDevices.getUserMedia({
        video:{facingMode:{ideal:'environment'}},
        audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},
      });
      phoneVideo.srcObject=phone.stream; await phoneVideo.play();
      for(const track of phone.stream.getTracks()) track.onended=()=>{
        reportPermissions(); sendPhone({type:'control',action:'pause'});
        phone.handsFree=false; stopRecognition(); stopFallbackCapture();
        setStatus('Camera or microphone access ended. Tap Start SeekR to reconnect.');
        el('allow-permissions').hidden=false;
      };
    }
    phone.handsFree=true; phone.awaitingInitialItem=!phone.hasTarget;
    document.body.classList.add('active'); el('target-section').hidden=false; el('allow-permissions').hidden=true;
    if(!phone.socket || phone.socket.readyState>WebSocket.OPEN) connectPhone();
    clearInterval(phone.frameTimer); phone.frameTimer=setInterval(sendFrame,200);
    reportPermissions(); setPhoneReady();
    await selectTranscriber();
    updateListeningStatus(phone.awaitingInitialItem
      ? `${phone.transcriber === 'elevenlabs' ? 'ElevenLabs Scribe' : phone.transcriber === 'browser' ? 'Browser speech recognition' : 'Mic'} is on. Say an item and its visual details, like “red cup.”`
      : undefined);
    startHandsFree();
  } catch(error) {
    phone.stream?.getTracks().forEach(track=>track.stop()); phone.stream=null;
    setStatus(error.name==='NotAllowedError'?'Allow camera and microphone access in this site’s settings, then try again.':'Camera or microphone is unavailable. Please try again.');
    sendPhone({type:'phone_status',camera:'unavailable',microphone:'unavailable',detail:error.name});
  } finally { phone.connecting=false; }
});
document.addEventListener('visibilitychange',()=>{
  if(document.hidden) { stopRecognition(); stopFallbackCapture(); }
  else if(phone.handsFree) startHandsFree();
});
if (pairSession) connectPhone(); else { setStatus('Scan the QR code on the computer to connect.'); el('allow-permissions').disabled=true; }
window.addEventListener('pagehide',()=>{
  stopPhoneInput(); phone.stream?.getTracks().forEach(track=>track.stop()); phone.socket?.close();
});
