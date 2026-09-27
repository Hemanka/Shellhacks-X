// Start at most four analyses per second; slow requests never accumulate.
const SCAN_INTERVAL_MS = 250;
const SCAN_POLL_MS = 50;
const MASK_INTERVAL_MS = 250;

const state = {
  running: false,
  startedAt: null,
  sightings: 0,
  heading: 0,
  registry: [],
  timer: null,
  scanTimer: null,
  stream: null,
  cameraActive: false,
  nextScanAt: null,
  remoteSocket: null,
  remoteFrame: null,
  listening: false,
  analyzing: false,
  backoffUntil: 0,
  revision: 0,
  maskAnalyzing: false,
  nextMaskAt: 0,
  localRouteFrameSeq: -1,
  localRouteAnalyzing: false,
  lastPerception: null,
  lastPerceptionMeta: null,
  remoteFrameId: 0,
  analyzedRemoteFrameId: -1,
  remoteFrameAt: 0,
  lastSpokenKey: null,
  lastSpokenAt: 0,
};
const $ = (id) => document.getElementById(id);
const targetInput = $("target-input");
const targetDisplay = $("target-display");
const startButton = $("start-button");
const video = $("camera-feed");
const canvas = document.createElement("canvas");
const routeCanvas = document.createElement("canvas");
function sendToPhone(message) {
  if (state.remoteSocket?.readyState !== WebSocket.OPEN) return false;
  state.remoteSocket.send(JSON.stringify(message)); return true;
}
function stopSpeaking() { sendToPhone({ type: 'stop_speech' }); }
async function speak(text) {
  const command = text.trim(); if (!command) return;
  const sent = sendToPhone({ type: 'guidance', text: command });
  window.SeekRDashboard?.event('speech output', { text: command, sent });
}

function phoneNow() {
  return state.phoneClock ? state.phoneClock.at + performance.now()-state.phoneClock.received : 0;
}
const navigation = window.NavigationController ? new window.NavigationController(cue => {
  if (!state.running || state.listening) return;
  if(cue.type==='cancel_hazard') { sendToPhone(cue); return; }
  setInstruction(cue.text, `${cue.stage} · ${cue.source}`, null, false);
  if (cue.type === 'PICKUP') setScanStatus('TARGET REACHED', 'NAVIGATION AND ROUTING PAUSED');
  sendToPhone({...cue,stream:state.frameMeta?.stream});
  window.SeekRDashboard?.event('speech output',cue);
}, snapshot=>window.SeekRDashboard?.controller?.(snapshot), {routeMode:true}) : null;
setInterval(()=>{
  if (!navigation || !state.running || state.listening) return;
  if (['SEARCH','RECOVER'].includes(navigation.stage)) navigation.tick(phoneNow(),state.orientation);
},100);

function setInstruction(title, sub, confidence = null, announce = true, spokenText = null) {
  $("instruction").textContent = title;
  $("instruction-sub").textContent = sub;
  $("confidence-value").textContent =
    confidence === null ? "—" : `${Math.round(confidence * 100)}%`;
  window.SeekRDashboard?.instruction(title, sub);
  if (announce && !state.listening) speak(spokenText ?? `${title} ${sub}`);
}

function cleanSpokenTarget(transcript) {
  let target = transcript.trim().replace(/[.!?]+$/, "");
  target = target.replace(
    /^(?:(?:hey(?:\s+there)?|hi|hello|okay|ok|um+|uh+|well|seekr|seeker)[,\s]+)+/i,
    "",
  );
  const prefixes = [
    /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:help me\s+)?(?:find|locate|look for)\s+(?:me\s+)?/i,
    /^(?:please\s+)?(?:what\s+)?i\s+want\s+to\s+find\s+is\s+/i,
    /^(?:please\s+)?i\s+(?:want|need|would like)(?:\s+you)?\s+to\s+(?:help\s+me\s+)?(?:find|locate|look for)\s+(?:me\s+)?/i,
    /^(?:please\s+)?i(?:'m| am)\s+looking\s+for\s+/i,
    /^(?:where is|where are)\s+/i,
    /^(?:please\s+)?(?:i(?:'d|d| would)?\s+like|i\s+(?:need|want))\s+(?:to find\s+)?/i,
  ];
  for (const prefix of prefixes) target = target.replace(prefix, "");
  return target
    .trim()
    .replace(/^(?:a|an|the|my|some)\s+/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

function setTarget(target) {
  state.revision += 1;
  navigation?.reset(target); stopSpeaking();
  state.lastPerception = null; state.lastPerceptionMeta = null; state.localRouteFrameSeq = -1;
  state.nextScanAt = 0;
  state.lastSpokenKey = null;
  targetInput.value = target;
  targetDisplay.textContent = target || "No target selected";
  targetDisplay.classList.toggle("empty", !target);
  startButton.disabled = !target;
  if (!state.running) {
    $("start-label").textContent = target ? "Start finding" : "Speak a target first";
  }
  $("target-map-label").textContent = target ? target.toUpperCase() : "TARGET";
}
function updateClock() {
  if (!state.startedAt) return;
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  $("session-time").textContent =
    `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  if (state.running && !state.analyzing && state.nextScanAt) {
    const seconds = Math.max(0, Math.ceil((state.nextScanAt - Date.now()) / 1000));
    $("scan-status").textContent = seconds ? `WAITING ${seconds}S` : "CAPTURING";
  }
}
function setScanStatus(status, cameraText = status) {
  $("scan-status").textContent = status;
  $("camera-label").textContent = cameraText;
}
function renderRegistry() {
  const list = $("registry-list");
  $("registry-count").textContent =
    `${state.registry.length} OBJECT${state.registry.length === 1 ? "" : "S"} TRACKED`;
  if (!state.registry.length) {
    list.innerHTML =
      '<div class="empty-registry">No objects registered yet. Start a scan to populate the room.</div>';
    return;
  }
  list.innerHTML = state.registry
    .map(
      (item) =>
        `<div class="registry-item ${item.target ? "target" : ""}"><span>${item.target ? "TARGET" : "OBSTACLE"}</span><b>${escapeText(item.label)}</b><small>${item.direction ? `${escapeText(item.direction)} · ` : ""}${item.score}% CONF.</small></div>`,
    )
    .join("");
}
function escapeText(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function renderDetections(candidates) {
  const layer = $("detection-layer");
  layer.innerHTML = candidates
    .map((candidate) => {
      const [x, y, width, height] = candidate.bbox;
      return `<div class="detection-box target-detection" data-object-label="${escapeText(candidate.label)}" style="left:${x * 100}%;top:${y * 100}%;width:${width * 100}%;height:${height * 100}%"><span>${escapeText(candidate.label.toUpperCase())} · ${Math.round(candidate.score * 100)}%</span></div>`;
    })
    .join("");
}
function renderTraversability(result) {
  if (!result?.overlayDataUrl) return;
  const overlay = $("traversability-overlay");
  overlay.src = result.overlayDataUrl;
  overlay.classList.add("active");
  const stats = result.percentages || {};
  $("traversability-readout").textContent =
    `CANDIDATE ${Math.round(stats.candidate_walkable || 0)}% · ` +
    `UNKNOWN ${Math.round(stats.unknown || 0)}% · ${Math.round(result.inferenceMs || 0)}MS`;
}
function addSightings(result) {
  const obstacles = result.perception?.obstacles || [];
  state.sightings += result.candidates.length + obstacles.length;
  $("detection-count").textContent =
    `${state.sightings} sighting${state.sightings === 1 ? "" : "s"}`;
  renderDetections(result.candidates);
  $("frame-label").textContent = `FRAME ${result.frame_id.toUpperCase()}`;
  $("camera-label").textContent =
    `${result.candidates.length} TARGET BOX${result.candidates.length === 1 ? "" : "ES"}`;
  if (state.cameraActive) $("camera-placeholder").classList.add("hidden");
  // Show this frame's evidence only; an old sighting must not look current.
  state.registry = result.candidates.slice(0, 5).map((candidate) => ({
    label: candidate.label,
    score: Math.round(candidate.score * 100),
    target: true,
  }));
  obstacles.forEach((obstacle) => state.registry.push({
    key: `${obstacle.label}:${obstacle.direction}`,
    label: obstacle.label,
    direction: obstacle.direction,
    score: Math.round(obstacle.confidence * 100),
    target: false,
  }));
  renderRegistry();
}

function applyNavigationDecision(result) {
  if (navigation) {
    const target = result.perception?.target;
    $("target-distance").textContent = target?.visible ? target.direction : "—";
    navigation.observe(result, result.frame_meta, phoneNow(), state.orientation);
    return;
  }
  const decision = result.decision;
  const target = result.perception?.target;
  if (!decision) return;

  const now = Date.now();
  const guidance = result.guidance;
  const announcementKey = guidance?.announcementKey || decision.action;
  const announce =
    announcementKey !== state.lastSpokenKey || now - state.lastSpokenAt >= 6000;
  setInstruction(
    guidance?.instruction || decision.voiceInstruction,
    guidance?.context || decision.reason,
    decision.confidence,
    announce,
    guidance?.spokenText || null,
  );
  if (announce) {
    state.lastSpokenKey = announcementKey;
    state.lastSpokenAt = now;
  }

  $("target-distance").textContent = target?.visible ? target.direction : "—";
  const targetPositions = { LEFT: "25%", CENTER: "50%", RIGHT: "75%" };
  if (target?.visible && targetPositions[target.direction]) {
    $("target-marker").style.left = targetPositions[target.direction];
  }
}

// The diagnostic mask must never delay guidance or queue more inference work.
function updateTraversability(requestBody, isCurrent) {
  if (state.maskAnalyzing || Date.now() < state.nextMaskAt) return Promise.resolve(null);
  state.maskAnalyzing = true;
  state.nextMaskAt = Date.now() + MASK_INTERVAL_MS;
  return fetch("/api/traversability-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  })
    .then(async (response) => {
      if (!response.ok) {
        let detail = '';
        try { detail = (await response.json()).detail || ''; } catch {}
        throw new Error(`Mask service returned ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      return response.json();
    })
    .then((result) => { if (isCurrent()) { renderTraversability(result); window.SeekRDashboard?.mask(result); return result; } return null; })
    .catch((error) => {
      state.nextMaskAt = Date.now() + 10000;
      if (isCurrent()) $("traversability-readout").textContent = "MASK UNAVAILABLE";
      window.SeekRDashboard?.event("mask error", { message: error.message });
      console.warn("Traversability overlay unavailable.", error);
      return null;
    })
    .finally(() => { state.maskAnalyzing = false; });
}

async function requestRouteForFrame(maskResult, perception, isCurrent) {
  if (!maskResult?.frame_meta || !isCurrent() || navigation?.pickupPending) return;
  const frameMeta = maskResult.frame_meta;
  if (frameMeta.stream !== state.frameMeta?.stream
    || frameMeta.capturedAt - (state.lastPerceptionMeta?.capturedAt ?? -Infinity) > 5000) return;
  if (!isCurrent() || !state.running || state.listening) return;
  navigation?.observeRoute({pathPlan:maskResult.pathPlan, maskSignature:maskResult.maskSignature,
    width:maskResult.width, height:maskResult.height}, frameMeta, phoneNow(), state.orientation,
    perception, state.lastPerceptionMeta);
}

// Accept short item descriptions without requiring the noun to appear in a
// finite catalog. Filter out obvious sentence/control words so full requests
// do not accidentally become the target.
const TARGET_SENTENCE_WORDS = new Set((
  'i me we you he she they it my our your his her their this that these those '
  +'am is are was were be been being do does did have has had want need would could should will '
  +'please find locate looking get take bring carry move put give send end exit task session navigation finish stop '
  +'and or but because while when who what where why'
).split(/\s+/));
function isItemDescription(target) {
  const words = target.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  return !words.some(word => TARGET_SENTENCE_WORDS.has(word));
}

async function analyzeLocalRouteFrame() {
  if (!state.running || state.listening || state.localRouteAnalyzing || state.maskAnalyzing
    || Date.now() < state.nextMaskAt || navigation?.pickupPending || !state.lastPerception
    || !state.lastPerceptionMeta || !state.frameMeta || !state.cameraActive) return;
  const perception = state.lastPerception, perceptionMeta = state.lastPerceptionMeta;
  const target = perception.target;
  if (!target?.visible || target.confidence < .8 || !state.frameMeta.stream
    || state.frameMeta.stream !== perceptionMeta.stream
    || state.frameMeta.capturedAt < perceptionMeta.capturedAt
    || state.frameMeta.capturedAt - perceptionMeta.capturedAt > 5000
    || state.frameMeta.seq <= state.localRouteFrameSeq
    || Date.now() - state.remoteFrameAt > 1000) return;

  const revision = state.revision, targetName = targetInput.value;
  const isCurrent = () => state.running && !state.listening && state.revision === revision
    && targetInput.value === targetName && state.lastPerception === perception
    && state.lastPerceptionMeta === perceptionMeta && !navigation?.pickupPending;
  const frameMeta = JSON.parse(JSON.stringify(state.frameMeta));
  const remoteFrame = state.remoteFrame;
  state.localRouteFrameSeq = frameMeta.seq;
  state.localRouteAnalyzing = true;
  try {
    if (remoteFrame) {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Phone frame could not be decoded for route planning'));
        image.src = remoteFrame;
      });
      routeCanvas.width = image.naturalWidth || 640;
      routeCanvas.height = image.naturalHeight || 480;
      routeCanvas.getContext('2d').drawImage(image, 0, 0);
    } else {
      routeCanvas.width = video.videoWidth || 640;
      routeCanvas.height = video.videoHeight || 480;
      routeCanvas.getContext('2d').drawImage(video, 0, 0);
    }
    if (!isCurrent()) return;
    const requestBody = {image_base64:routeCanvas.toDataURL('image/jpeg', .8),
      target_object:targetInput.value, heading_deg:state.heading, frame_meta:frameMeta, perception};
    const maskResult = await updateTraversability(requestBody, isCurrent);
    if (maskResult) await requestRouteForFrame(maskResult, perception, isCurrent);
  } catch (error) {
    if (isCurrent()) window.SeekRDashboard?.event('route error', {message:error.message});
    console.warn('Fast local route update unavailable.', error);
  } finally { state.localRouteAnalyzing = false; }
}

async function analyzeFrame() {
  if (state.analyzing || !state.running || state.listening || navigation?.pickupPending ||
      Date.now() < Math.max(state.backoffUntil, state.nextScanAt || 0)) return;
  if (state.remoteFrame && (state.remoteFrameId === state.analyzedRemoteFrameId ||
      Date.now() - state.remoteFrameAt > 2000)) return;
  if (!state.stream && !state.remoteFrame) {
    $("camera-label").textContent = "NO FRAME TO ANALYZE";
    setInstruction("Camera unavailable.", "Allow camera access before sending a frame to Gemini.", 0);
    return;
  }
  state.analyzing = true;
  const revision = state.revision;
  const target = targetInput.value;
  const isCurrent = () => state.running && !state.listening &&
    state.revision === revision && targetInput.value === target && !navigation?.pickupPending;
  state.nextScanAt = Date.now() + SCAN_INTERVAL_MS;
  const captureStarted = performance.now();
  try {
    const frameMeta = state.frameMeta ? JSON.parse(JSON.stringify(state.frameMeta)) : null;
    if (state.remoteFrame) {
      const remoteImage = new Image();
      state.analyzedRemoteFrameId = state.remoteFrameId;
      await new Promise((resolve, reject) => {
        remoteImage.onload = resolve;
        remoteImage.onerror = () => reject(new Error("Phone frame could not be decoded"));
        remoteImage.src = state.remoteFrame;
      });
      canvas.width = remoteImage.naturalWidth || 640;
      canvas.height = remoteImage.naturalHeight || 480;
      canvas.getContext("2d").drawImage(remoteImage, 0, 0);
    } else {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext("2d").drawImage(video, 0, 0);
    }
    if (!isCurrent()) return;
    setScanStatus("PROCESSING", "PROCESSING CAMERA-RELATIVE SCENE");
    const image = canvas.toDataURL("image/jpeg", 0.85);
    const captureMs = performance.now() - captureStarted;
    const requestBody = {
      image_base64: image,
      target_object: target,
      heading_deg: state.heading,
      capture_ms: captureMs,
      frame_meta: frameMeta,
    };
    const response = await fetch("/api/analyze-frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      let detail = "Frame analysis failed";
      try {
        detail = (await response.json()).detail || detail;
      } catch {
        // Keep the generic message when the server returns a non-JSON error.
      }
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    const result = await response.json();
    if (!isCurrent()) return;
    window.SeekRDashboard?.result(result);
    addSightings(result);
    if (result.rateLimited) {
      const retryMs = Math.max(result.retryAfterMs || 30000, SCAN_INTERVAL_MS);
      const retrySeconds = Math.ceil(retryMs / 1000);
      state.backoffUntil = Date.now() + retryMs;
      state.nextScanAt = state.backoffUntil;
      setInstruction(
        "Vision service is busy.",
        `Hold your position. Retrying in about ${retrySeconds} seconds.`,
        0,
      );
      setScanStatus("COOLDOWN", `GEMINI RATE LIMITED / RETRY IN ${retrySeconds}S`);
      return;
    }
    state.backoffUntil = 0;
    const perceptionMeta = result.frame_meta || frameMeta;
    if (result.perception && perceptionMeta?.stream === state.frameMeta?.stream
      && perceptionMeta.capturedAt > (navigation?.movementAt ?? -Infinity)
      && (!state.lastPerceptionMeta || perceptionMeta.stream !== state.lastPerceptionMeta.stream
        || perceptionMeta.seq >= state.lastPerceptionMeta.seq)) {
      const streamChanged = state.lastPerceptionMeta?.stream !== perceptionMeta.stream;
      state.lastPerception = result.perception;
      state.lastPerceptionMeta = perceptionMeta;
      state.localRouteFrameSeq = streamChanged ? perceptionMeta.seq - 1
        : Math.min(state.localRouteFrameSeq, perceptionMeta.seq - 1);
    }
    applyNavigationDecision(result);
    if (navigation?.pickupPending) setScanStatus('TARGET REACHED', 'NAVIGATION AND ROUTING PAUSED');
    else setScanStatus("LIVE", result.decision.action);
    console.info("Navigation response latency", {
      responseMs: Math.round(performance.now() - captureStarted),
      nextRequestInMs: Math.max(0, state.nextScanAt - Date.now()),
    });
    $("heading-value").textContent =
      `${String(Math.round(result.heading_deg + 360) % 360).padStart(3, "0")}°`;
    console.info("Navigation cycle timings", result.timings);
  } catch (error) {
    if (!isCurrent()) return;
    state.backoffUntil = Date.now() + 1000;
    window.SeekRDashboard?.event("analysis error", { message: error.message });
    throw error;
  } finally {
    state.analyzing = false;
    window.SeekRDashboard?.loop(state);
  }
}
async function connectCamera() {
  if (!state.cameraActive || !state.remoteFrame) throw new Error('Waiting for the paired phone camera.');
  return true;
}

async function startSession() {
  if (!targetInput.value.trim()) {
    speak("Tell me what you want to find first.");
    return;
  }
  if (!state.running && !state.cameraActive) {
    setInstruction('Waiting for phone camera.', 'Allow camera access on the paired phone, then start again.');
    return;
  }
  state.running = !state.running;
  state.revision += 1;
  state.nextScanAt = 0;
  state.lastSpokenKey = null;
  sendToPhone({ type: "session_state", running: state.running, target: targetInput.value, revision: navigation?.revision ?? 0 });
  if (!state.running) {
    navigation?.invalidate("Session paused"); stopSpeaking();
    $("session-state").textContent = "Paused";
    $("start-label").textContent = "Resume finding";
    clearInterval(state.timer);
    clearInterval(state.scanTimer);
    state.nextScanAt = null;
    $("scan-status").textContent = "PAUSED";
    setInstruction("Session paused.", "Press resume when you are ready to continue.");
    return;
  }
  $("session-state").textContent = "Scanning";
  $("start-label").textContent = "Pause session";
  $("connection-label").textContent = "VISION LOOP ACTIVE";
  state.quotaAnnounced = false;
  setScanStatus("CAPTURING", "CAPTURING LIVE FRAME");
  if (!state.startedAt) {
    state.startedAt = Date.now();
    state.timer = setInterval(updateClock, 1000);
  }
  setInstruction(
    "Hold still while I check this view.",
    `I'll check this view for your ${targetInput.value}.`,
  );
  try {
    await connectCamera();
    $("camera-label").textContent = "LIVE CAMERA / ANALYZING";
  } catch (error) {
    if (!state.cameraActive) {
      $("connection-label").textContent = "CAMERA ACCESS BLOCKED";
      $("camera-label").textContent = "ALLOW CAMERA ACCESS AND TRY AGAIN";
      $("camera-placeholder")?.querySelector(".placeholder-kicker")?.replaceChildren("PERMISSION NEEDED");
      $("camera-placeholder")?.querySelector("strong")?.replaceChildren("Camera access was blocked");
      $("camera-placeholder")?.querySelector("span:last-child")?.replaceChildren("Allow camera access and try again.");
      $("instruction-sub").textContent = "Allow camera access before starting the scan.";
    }
    window.SeekRDashboard?.event("camera", { message: error.message });
  }
  try {
    await analyzeFrame();
  } catch (error) {
    if (error.status === 429 || error.message.includes("quota")) {
      $("session-state").textContent = "Scanning";
      $("start-label").textContent = "Pause session";
      setScanStatus("WAITING QUOTA", "CAMERA ACTIVE / GEMINI WAITING");
      setInstruction("Waiting for Gemini quota.", "The camera is still active. Retrying in 3 seconds.", 0, false);
      if (!state.quotaAnnounced) {
        state.quotaAnnounced = true;
        speak("Processing");
      }
    } else {
      setScanStatus("RETRYING", "LIVE CAMERA / GEMINI RETRYING");
    }
    setInstruction("Vision analysis unavailable.", error.message, 0);
    console.warn("Vision analysis failed.", error);
  }
  clearInterval(state.scanTimer);
  state.scanTimer = setInterval(() => {
    if (state.running && state.cameraActive && !state.listening) {
      void analyzeLocalRouteFrame();
      if (Date.now() >= state.backoffUntil) analyzeFrame().catch((error) => {
        if (error.status === 429 || error.message.includes("quota")) {
          $("session-state").textContent = "Scanning";
          $("start-label").textContent = "Pause session";
          setScanStatus("WAITING QUOTA", "CAMERA ACTIVE / GEMINI WAITING");
          setInstruction("Waiting for Gemini quota.", "The camera is still active. Retrying in 3 seconds.", 0, false);
          if (!state.quotaAnnounced) {
            state.quotaAnnounced = true;
            speak("Processing");
          }
        } else {
          setScanStatus("RETRYING", "LIVE CAMERA / GEMINI RETRYING");
        }
        console.warn("Frame analysis failed.", error);
      });
    }
  }, SCAN_POLL_MS);
}
async function useTranscript(transcript) {
  state.listening = false;
  const spokenControl = transcript.toLowerCase().trim().replace(/[.!?]+$/, '');
  if (['exit task', 'exit the task', 'finish task', 'finish the task', 'exit session', 'finish navigation', 'exit navigation', 'im done', 'i am done'].includes(spokenControl)) {
    const exitedTarget = targetInput.value;
    state.running = false; state.revision++; clearInterval(state.scanTimer);
    setTarget('');
    $('session-state').textContent = 'Task exited';
    setScanStatus('TASK ENDED', 'STOPPED BY VOICE');
    setInstruction('Task exited.', exitedTarget ? `Navigation stopped for ${exitedTarget}.` : 'Navigation stopped.', null, false);
    window.SeekRDashboard?.event('speech input', { transcript, command: 'exit task' });
    sendToPhone({ type: 'session_state', running: false, target: '', revision: navigation?.revision ?? 0 });
    speak(`Task exited. ${exitedTarget ? `I stopped navigation to the ${exitedTarget}. ` : ''}Name another item when you are ready.`);
    return 'task-exited';
  }
  if (['resume', 'continue'].includes(spokenControl)) {
    if (!state.running) await startSession();
    return;
  }
  const command = navigation?.command(transcript, phoneNow());
  if(command) {
    window.SeekRDashboard?.event('speech input',{transcript,command});
    if(command==='pause' && state.running) await startSession();
    if(command==='complete') {
      state.running=false; state.revision++; clearInterval(state.scanTimer);
      $("session-state").textContent='Complete'; $("start-label").textContent='Start finding';
      // Stop analysis immediately; allow the short completion acknowledgment to play.
      setTimeout(()=>{if(!state.running) sendToPhone({type:'session_state',running:false,target:targetInput.value,revision:navigation.revision});},4000);
    }
    return;
  }
  const target = cleanSpokenTarget(transcript).slice(0, 100);
  if (!isItemDescription(target)) {
    setInstruction('Tell me an item to find.', 'Use an item name with optional visual details, like “red cup” or “black hoodie.”');
    window.SeekRDashboard?.event('target rejected', { transcript, target });
    return;
  }
  state.listening = false;
  setTarget(target);
  window.SeekRDashboard?.event('speech input', { transcript, target });
  if (state.running) {
    sendToPhone({ type: 'session_state', running: true, target, revision:navigation?.revision ?? 0 });
    setInstruction('Target updated.', 'Looking for ' + target + '.');
    await analyzeFrame();
  } else if (state.cameraActive) {
    await startSession();
  } else {
    setInstruction('Waiting for phone camera.', 'Your target is ready. Allow camera access on your phone.');
  }
}
startButton.addEventListener('click', () => startSession().catch(error => window.SeekRDashboard?.event('error', { message: error.message })));
setTarget(targetInput.value);
renderRegistry();
