const phone = {
  socket: null, stream: null, recorder: null, frameTimer: null, recordTimer: null,
  dashboard: false, running: false, listening: false, lastGuidance: '', connecting: false, commandRevision: 0,
};
const el = id => document.getElementById(id);
const phoneVideo = el('phone-video');
const captureCanvas = document.createElement('canvas');
const pairSession = new URLSearchParams(location.search).get('session');
function sendPhone(message) {
  if (phone.socket?.readyState === WebSocket.OPEN) phone.socket.send(JSON.stringify(message));
}
const speech = new WayfinderSpeech((state, detail) => {
  sendPhone({ type: 'phone_status', speech: state, detail });
  if (state === 'blocked') el('status').textContent = 'Tap Hear again to hear the instruction.';
});
phone.streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
phone.frameSeq = 0; phone.revision = 0;
const orientation = window.PhoneOrientation ? new window.PhoneOrientation(detail => sendPhone({type:'phone_status',orientation:detail})) : null;
const feedback = window.PhoneFeedback ? new window.PhoneFeedback(speech,
  (kind,detail)=>sendPhone({type:'phone_status',...(kind==='haptics'?{haptics:detail}:{}),detail}),
  cue=>{phone.lastGuidance=cue.text;el('spoken-output').textContent=cue.text;el('repeat-guidance').disabled=false;},
  ()=>{phone.commandRevision++; if(phone.recorder?.state==='recording') phone.recorder.stop(); phone.listening=false; sendPhone({type:'listening',active:false});}
) : null;
setInterval(()=>{
  const sample=orientation?.current();
  if(sample && phone.dashboard && phone.socket?.bufferedAmount===0) sendPhone({type:'orientation',stream:phone.streamId,orientation:sample});
},100);
function showStatus(text) { el('status').textContent = text; }
function reportPermissions() {
  sendPhone({ type: 'phone_status',
    camera: phone.stream?.getVideoTracks().some(track => track.readyState === 'live') ? 'allowed' : 'not ready',
    microphone: phone.stream?.getAudioTracks().some(track => track.readyState === 'live') ? 'allowed' : 'not ready',
  });
}
function setPhoneReady() {
  const ready = phone.dashboard && !!phone.stream;
  el('record-command').disabled = !ready;
  el('pause-guidance').disabled = !ready;
  el('pause-guidance').textContent = phone.running ? 'Pause guidance' : 'Resume guidance';
  if (ready) showStatus('Ready. Tap to tell me what to find.');
}
function stopPhoneInput() {
  phone.commandRevision++; feedback?.cancel();
  clearInterval(phone.frameTimer); clearTimeout(phone.recordTimer);
  if (phone.recorder?.state === 'recording') phone.recorder.stop();
  phone.listening = false; speech.stop();
}
function connectPhone() {
  if (!pairSession) { showStatus('Scan the QR code on the computer to connect.'); return; }
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${location.host}/ws/pair/${pairSession}?role=mobile`);
  phone.socket = socket;
  socket.onopen = () => { reportPermissions(); };
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.type === 'peer_status') {
      phone.dashboard = message.connected;
      if (!phone.dashboard) {
        phone.running = false; stopPhoneInput();
        showStatus('Computer disconnected. Hold your position.');
        el('spoken-output').textContent = 'Stop. Hold your position.';
        speech.speak('Stop. The computer disconnected. Hold your position.');
      } else if (phone.stream) {
        clearInterval(phone.frameTimer); phone.frameTimer = setInterval(sendFrame, 200);
      }
      setPhoneReady(); reportPermissions();
    } else if ((message.type === 'hazard' || (message.type === 'guidance' && !phone.listening)) && message.id && feedback) {
      feedback.accept(message);
    } else if (message.type === 'cancel_hazard') {
      try { navigator.vibrate?.(0); } catch {}
    } else if (message.type === 'guidance' && !phone.listening) {
      phone.lastGuidance = message.text; el('spoken-output').textContent = message.text;
      el('repeat-guidance').disabled = false; speech.speak(message.text);
    } else if (message.type === 'stop_speech') {
      feedback?.cancel(); speech.stop();
    } else if (message.type === 'session_state') {
      phone.running = message.running;
      phone.revision = message.revision ?? phone.revision;
      feedback?.session(phone.revision,phone.streamId,phone.running);
      el('pause-guidance').textContent = phone.running ? 'Pause guidance' : 'Resume guidance';
    }
  };
  socket.onclose = () => {
    if (phone.socket !== socket) return;
    phone.dashboard = false; phone.running = false; stopPhoneInput();
    el('record-command').disabled = true; el('pause-guidance').disabled = true;
    el('allow-permissions').hidden = false; el('allow-permissions').textContent = 'Reconnect';
    showStatus('Connection lost. Hold your position, then reconnect.');
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
el('allow-permissions').addEventListener('click', async () => {
  if (phone.connecting) return;
  if (!pairSession) { showStatus('Scan the QR code on the computer first.'); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    showStatus('Open the secure phone link from the computer QR code to allow camera and microphone access.'); return;
  }
  speech.unlock(); feedback?.unlock(); orientation?.enable(); phone.connecting = true;
  try {
    if (!phone.stream || phone.stream.getTracks().some(track => track.readyState !== 'live')) {
      phone.stream?.getTracks().forEach(track => track.stop());
      phone.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: true });
      phoneVideo.srcObject = phone.stream; await phoneVideo.play();
      for (const track of phone.stream.getTracks()) track.onended = () => {
        reportPermissions(); sendPhone({ type: 'control', action: 'pause' });
        showStatus('Camera or microphone access ended. Allow access again.');
        el('allow-permissions').hidden = false; el('record-command').disabled = true;
      };
    }
    el('allow-permissions').hidden = true;
    if (!phone.socket || phone.socket.readyState > WebSocket.OPEN) connectPhone();
    clearInterval(phone.frameTimer); phone.frameTimer = setInterval(sendFrame, 200);
    reportPermissions(); setPhoneReady();
  } catch (error) {
    phone.stream?.getTracks().forEach(track => track.stop()); phone.stream = null;
    showStatus(error.name === 'NotAllowedError' ? 'Allow camera and microphone access in this site’s settings, then try again.' : 'Camera or microphone is unavailable. Please try again.');
    sendPhone({ type: 'phone_status', camera: 'unavailable', microphone: 'unavailable', detail: error.name });
  } finally { phone.connecting = false; }
});

el('record-command').addEventListener('click', () => {
  if (phone.recorder?.state === 'recording') { phone.recorder.stop(); return; }
  if (!phone.stream || !phone.dashboard) return;
  if (!window.MediaRecorder) { showStatus('Voice recording is unavailable in this browser.'); return; }
  feedback?.cancel(); speech.stop(); phone.listening = true; sendPhone({ type: 'listening', active: true });
  el('record-command').classList.add('recording'); el('record-command').textContent = 'Tap to finish';
  showStatus('Listening. Tell me what you want to find.');
  const chunks = [];
  const commandRevision = ++phone.commandRevision;
  try {
    const audio = new MediaStream(phone.stream.getAudioTracks());
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = mimeType ? new MediaRecorder(audio, { mimeType }) : new MediaRecorder(audio);
    phone.recorder = recorder;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      clearTimeout(phone.recordTimer); el('record-command').disabled = true;
      el('record-command').classList.remove('recording'); el('record-command').textContent = 'Tap to speak';
      phone.recorder = null;
      try {
        if (!phone.dashboard || commandRevision !== phone.commandRevision) return;
        showStatus('Understanding your request…');
        const form = new FormData();
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        form.append('file', blob, blob.type.includes('mp4') ? 'command.m4a' : 'command.webm');
        const response = await fetch('/api/transcribe', { method: 'POST', body: form });
        const result = await response.json();
        if (!response.ok) throw new Error(result.detail || 'Voice input unavailable');
        if (!phone.dashboard || commandRevision !== phone.commandRevision) return;
        el('transcript').textContent = result.text;
        sendPhone({ type: 'transcript', text: result.text });
        showStatus('Request sent. Listen for your next step.');
        sendPhone({ type: 'phone_status', detail: 'Voice command transcribed' });
      } catch (error) {
        showStatus('I could not understand that. Tap to try again.');
        sendPhone({ type: 'phone_status', detail: error.message });
      } finally {
        phone.listening = false; sendPhone({ type: 'listening', active: false });
        el('record-command').disabled = !phone.dashboard;
      }
    };
    recorder.start(); phone.recordTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 8000);
  } catch (error) {
    phone.listening = false; sendPhone({ type: 'listening', active: false });
    el('record-command').classList.remove('recording'); el('record-command').textContent = 'Tap to speak';
    showStatus('Voice recording could not start. Please try again.');
    sendPhone({ type: 'phone_status', detail: error.message });
  }
});
el('repeat-guidance').addEventListener('click', () => { speech.unlock(); if (feedback) feedback.repeat(); else if (phone.lastGuidance) speech.speak(phone.lastGuidance); });
el('pause-guidance').addEventListener('click', () => {
  phone.commandRevision++;
  if (phone.recorder?.state === 'recording') phone.recorder.stop();
  speech.stop(); sendPhone({ type: 'control', action: phone.running ? 'pause' : 'resume' });
});
if (pairSession) connectPhone(); else { showStatus('Scan the QR code on the computer to connect.'); el('allow-permissions').disabled = true; }
window.addEventListener('pagehide', () => {
  stopPhoneInput(); phone.stream?.getTracks().forEach(track => track.stop()); phone.socket?.close();
});
