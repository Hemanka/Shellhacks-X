const phone = {
  socket: null, stream: null, frameTimer: null,
  dashboard: false, running: false, listening: false, lastGuidance: '', connecting: false,
  voiceRecorder: null, voiceStream: null, voiceChunks: [], voiceTimer: null, recognizer: null,
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
  if (state === 'blocked') el('status').textContent = 'Audio is blocked. Tap Hear again to retry the instruction.';
  else if (state === 'fallback') showStatus(detail);
});
phone.streamId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
phone.frameSeq = 0; phone.revision = 0;
const orientation = window.PhoneOrientation ? new window.PhoneOrientation(detail => sendPhone({type:'phone_status',orientation:detail})) : null;
const feedback = window.PhoneFeedback ? new window.PhoneFeedback(speech,
  (kind,detail)=>sendPhone({type:'phone_status',...(kind==='haptics'?{haptics:detail}:{}),detail}),
  cue=>{phone.lastGuidance=cue.text;el('spoken-output').textContent=cue.text;el('repeat-guidance').disabled=false;},
  ()=>{phone.listening=false;}
) : null;
setInterval(()=>{
  const sample=orientation?.current();
  if(sample && phone.dashboard && phone.socket?.bufferedAmount===0) sendPhone({type:'orientation',stream:phone.streamId,orientation:sample});
},100);
function showStatus(text) { el('status').textContent = text; }
function reportPermissions() {
  sendPhone({ type: 'phone_status',
    camera: phone.stream?.getVideoTracks().some(track => track.readyState === 'live') ? 'allowed' : 'not ready',
  });
}
function setPhoneReady() {
  const ready = phone.dashboard && !!phone.stream;
  el('voice-command').disabled = !phone.dashboard || !phone.stream;
  el('pause-guidance').disabled = !ready;
  el('pause-guidance').textContent = phone.running ? 'Pause guidance' : 'Resume guidance';
  if (ready) showStatus('Connected. Tap Start speaking to say what you want to find or answer.');
}
function stopPhoneInput() {
  clearTimeout(phone.voiceTimer); phone.voiceTimer = null;
  if (phone.recognizer) {
    const recognizer = phone.recognizer; phone.recognizer = null;
    recognizer.onend = null; recognizer.onerror = null;
    try { recognizer.abort(); } catch {}
  }
  if (phone.voiceRecorder?.state === 'recording') {
    phone.voiceRecorder.__wayfinderCanceled = true;
    phone.voiceRecorder.stop();
  }
  phone.voiceStream?.getTracks().forEach(track => track.stop()); phone.voiceStream = null;
  feedback?.cancel();
  clearInterval(phone.frameTimer);
  if (phone.listening) sendPhone({ type: 'listening', active: false });
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
    el('voice-command').disabled = true; el('pause-guidance').disabled = true;
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
    showStatus('Open the secure phone link from the computer QR code to allow camera access.'); return;
  }
  speech.unlock(); feedback?.unlock(); orientation?.enable(); phone.connecting = true;
  try {
    if (!phone.stream || phone.stream.getTracks().some(track => track.readyState !== 'live')) {
      phone.stream?.getTracks().forEach(track => track.stop());
      phone.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      phoneVideo.srcObject = phone.stream; await phoneVideo.play();
      for (const track of phone.stream.getTracks()) track.onended = () => {
        reportPermissions(); sendPhone({ type: 'control', action: 'pause' });
        showStatus('Camera access ended. Allow access again.');
        el('allow-permissions').hidden = false;
      };
    }
    el('allow-permissions').hidden = true;
    if (!phone.socket || phone.socket.readyState > WebSocket.OPEN) connectPhone();
    clearInterval(phone.frameTimer); phone.frameTimer = setInterval(sendFrame, 200);
    reportPermissions(); setPhoneReady();
  } catch (error) {
    phone.stream?.getTracks().forEach(track => track.stop()); phone.stream = null;
    showStatus(error.name === 'NotAllowedError' ? 'Allow camera access in this site’s settings, then try again.' : 'Camera is unavailable. Please try again.');
    sendPhone({ type: 'phone_status', camera: 'unavailable', detail: error.name });
  } finally { phone.connecting = false; }
});

function setVoiceListening(active, message) {
  phone.listening = active;
  sendPhone({ type: 'listening', active });
  el('voice-command').setAttribute('aria-pressed', String(active));
  el('voice-command').classList.toggle('recording', active);
  el('voice-command').textContent = active ? 'Stop speaking' : 'Start speaking';
  el('voice-status').textContent = message;
  if (!active) setPhoneReady();
}
function startBrowserRecognition(Recognition) {
  const recognizer = phone.recognizer = new Recognition();
  recognizer.lang = navigator.language || 'en-US';
  recognizer.continuous = false; recognizer.interimResults = false; recognizer.maxAlternatives = 1;
  setVoiceListening(true, 'Listening. Say your target or answer now.');
  const finish = text => {
    if (phone.recognizer !== recognizer) return;
    clearTimeout(phone.voiceTimer); phone.voiceTimer = null; phone.recognizer = null;
    phone.listening = false; sendPhone({ type: 'listening', active: false });
    el('voice-command').setAttribute('aria-pressed', 'false');
    el('voice-command').classList.remove('recording');
    el('voice-command').textContent = 'Start speaking';
    if (!text) { el('voice-status').textContent = 'I did not hear speech. Tap Start speaking and try again.'; setPhoneReady(); return; }
    el('voice-status').textContent = `I heard: ${text}`;
    if (phone.dashboard) sendPhone({ type: 'transcript', text });
  };
  recognizer.onresult = event => finish(event.results?.[0]?.[0]?.transcript?.trim() || '');
  recognizer.onerror = event => {
    if (phone.recognizer !== recognizer) return;
    clearTimeout(phone.voiceTimer); phone.voiceTimer = null; phone.recognizer = null;
    const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Allow microphone and speech recognition access in your browser settings, then try again.'
      : 'I could not hear that. Tap Start speaking and try again.';
    setVoiceListening(false, message);
    sendPhone({ type: 'phone_status', microphone: 'speech recognition failed', detail: event.error || 'unknown error' });
  };
  recognizer.onend = () => {
    if (phone.recognizer !== recognizer) return;
    finish('');
  };
  phone.voiceTimer = setTimeout(() => { if (phone.recognizer === recognizer) { try { recognizer.stop(); } catch {} } }, 8000);
  try { recognizer.start(); }
  catch { clearTimeout(phone.voiceTimer); phone.voiceTimer = null; phone.recognizer = null; setVoiceListening(false, 'Microphone is unavailable. Tap Start speaking to try again.'); }
}
async function transcribeRecording(blob, mimeType) {
  try {
    if (!blob.size) throw new Error('No audio was recorded. Tap the microphone and try again.');
    el('voice-status').textContent = 'Transcribing your speech. One moment.';
    const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    const form = new FormData();
    form.append('file', blob, `voice-command.${extension}`);
    const response = await fetch('/api/transcribe', { method: 'POST', body: form });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).detail || ''; } catch {}
      throw new Error(detail || `Transcription failed (${response.status}).`);
    }
    const result = await response.json();
    const text = String(result.text || '').trim();
    if (!text) throw new Error('I did not hear speech. Tap the microphone and try again.');
    el('voice-status').textContent = `I heard: ${text}`;
    // Clear the dashboard's listening state before delivering the transcript.
    // This lets its next fresh camera frame drive the search or route.
    phone.listening = false;
    sendPhone({ type: 'listening', active: false });
    if (phone.dashboard) sendPhone({ type: 'transcript', text });
    else el('voice-status').textContent = 'Computer disconnected. Reconnect and try again.';
  } catch (error) {
    phone.listening = false;
    sendPhone({ type: 'listening', active: false });
    el('voice-status').textContent = error.message || 'Microphone input failed. Tap and try again.';
    sendPhone({ type: 'phone_status', microphone: 'transcription failed', detail: error.message || 'unknown error' });
    speech.speak('I could not understand that. Tap Start speaking and try again.');
  } finally {
    phone.voiceStream?.getTracks().forEach(track => track.stop());
    phone.voiceStream = null; phone.voiceRecorder = null; phone.voiceChunks = [];
    clearTimeout(phone.voiceTimer); phone.voiceTimer = null;
    el('voice-command').textContent = 'Start speaking';
    el('voice-command').setAttribute('aria-pressed', 'false');
    el('voice-command').classList.remove('recording');
    setPhoneReady();
  }
}
async function startVoiceCommand() {
  if (!phone.dashboard || !phone.stream) return;
  if (phone.voiceRecorder?.state === 'recording') {
    phone.voiceRecorder.stop();
    el('voice-command').disabled = true;
    el('voice-status').textContent = 'Finishing recording. One moment.';
    return;
  }
  feedback?.cancel(); speech.stop(); speech.unlock(); feedback?.unlock();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Recognition) { startBrowserRecognition(Recognition); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    el('voice-status').textContent = 'This browser cannot record speech. Try a current version of Safari or Chrome.';
    return;
  }
  setVoiceListening(true, 'Requesting microphone access.');
  try {
    phone.voiceStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = candidates.find(type => MediaRecorder.isTypeSupported(type));
    phone.voiceRecorder = mimeType ? new MediaRecorder(phone.voiceStream, { mimeType }) : new MediaRecorder(phone.voiceStream);
    const recorder = phone.voiceRecorder;
    const chunks = phone.voiceChunks = [];
    recorder.ondataavailable = event => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = () => {
      recorder.__wayfinderCanceled = true;
      clearTimeout(phone.voiceTimer); phone.voiceTimer = null;
      phone.voiceStream?.getTracks().forEach(track => track.stop()); phone.voiceStream = null;
      phone.voiceRecorder = null; setVoiceListening(false, 'Microphone recording failed. Tap to try again.');
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'audio/webm';
      if (recorder.__wayfinderCanceled) {
        phone.voiceStream?.getTracks().forEach(track => track.stop());
        phone.voiceStream = null; phone.voiceRecorder = null; phone.voiceChunks = [];
        return;
      }
      void transcribeRecording(new Blob(chunks, { type }), type);
    };
    recorder.start();
    el('voice-command').disabled = false;
    el('voice-status').textContent = 'Listening. Speak your target or answer, then tap Stop speaking. Recording stops after eight seconds.';
    phone.voiceTimer = setTimeout(() => {
      if (recorder.state === 'recording') {
        recorder.stop(); el('voice-command').disabled = true;
        el('voice-status').textContent = 'Recording finished. Transcribing your speech.';
      }
    }, 8000);
    sendPhone({ type: 'phone_status', microphone: 'recording' });
  } catch (error) {
    phone.voiceStream?.getTracks().forEach(track => track.stop()); phone.voiceStream = null;
    setVoiceListening(false, error.name === 'NotAllowedError' ? 'Allow microphone access in your browser settings, then tap Start speaking.' : 'Microphone unavailable. Tap to try again.');
    sendPhone({ type: 'phone_status', microphone: 'unavailable', detail: error.name || 'unknown error' });
  }
}
el('voice-command').addEventListener('click', () => { void startVoiceCommand(); });
el('repeat-guidance').addEventListener('click', () => { speech.unlock(); if (feedback) feedback.repeat(); else if (phone.lastGuidance) speech.speak(phone.lastGuidance); });
el('pause-guidance').addEventListener('click', () => {
  speech.stop(); sendPhone({ type: 'control', action: phone.running ? 'pause' : 'resume' });
});
if (pairSession) connectPhone(); else { showStatus('Scan the QR code on the computer to connect.'); el('allow-permissions').disabled = true; }
window.addEventListener('pagehide', () => {
  stopPhoneInput(); phone.stream?.getTracks().forEach(track => track.stop()); phone.socket?.close();
});
