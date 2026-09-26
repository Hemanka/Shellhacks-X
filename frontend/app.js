const SCAN_INTERVAL_MS = 6000;

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
  lastSpokenAction: null,
  lastSpokenAt: 0,
};
const $ = (id) => document.getElementById(id);
const targetInput = $("target-input");
const targetDisplay = $("target-display");
const startButton = $("start-button");
const cameraButton = $("camera-button");
const pairButton = $("pair-button");
const closePairing = $("close-pairing");
const micButton = $("mic-button");
const video = $("camera-feed");
const canvas = document.createElement("canvas");
let activeAudio = null;
let activeAudioUrl = null;
let speechSequence = 0;
let voiceRecorder = null;
let voiceRecorderTimeout = null;

function stopSpeaking() {
  speechSequence += 1;
  window.speechSynthesis?.cancel();
  if (activeAudio) {
    activeAudio.pause();
    activeAudio = null;
  }
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

function speakWithBrowser(text, sequence) {
  if (!("speechSynthesis" in window) || sequence !== speechSequence) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  window.speechSynthesis.speak(utterance);
}

async function speak(text) {
  const command = text.trim();
  if (!command) return;

  stopSpeaking();
  const sequence = speechSequence;

  try {
    const response = await fetch("/api/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: command }),
    });
    if (!response.ok) throw new Error(`Speech service returned ${response.status}`);

    const audioUrl = URL.createObjectURL(await response.blob());
    if (sequence !== speechSequence) {
      URL.revokeObjectURL(audioUrl);
      return;
    }
    const audio = new Audio(audioUrl);
    activeAudio = audio;
    activeAudioUrl = audioUrl;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      URL.revokeObjectURL(audioUrl);
      if (activeAudio === audio) activeAudio = null;
      if (activeAudioUrl === audioUrl) activeAudioUrl = null;
    };
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    try {
      await audio.play();
    } catch (error) {
      release();
      throw error;
    }
  } catch (error) {
    console.warn("ElevenLabs speech unavailable; using browser voice.", error);
    speakWithBrowser(command, sequence);
  }
}

function setInstruction(title, sub, confidence = null, announce = true) {
  $("instruction").textContent = title;
  $("instruction-sub").textContent = sub;
  $("confidence-value").textContent =
    confidence === null ? "—" : `${Math.round(confidence * 100)}%`;
  if (announce && !state.listening) speak(`${title} ${sub}`);
}

function cleanSpokenTarget(transcript) {
  let target = transcript.trim().replace(/[.!?]+$/, "");
  target = target.replace(
    /^(?:(?:hey(?:\s+there)?|hi|hello|okay|ok|um+|uh+|well|wayfinder)[,\s]+)+/i,
    "",
  );
  const prefixes = [
    /^(?:please\s+)?(?:(?:can|could|would) you\s+)?(?:help me\s+)?(?:find|locate|look for)\s+(?:me\s+)?/i,
    /^(?:please\s+)?(?:what\s+)?i\s+want\s+to\s+find\s+is\s+/i,
    /^(?:please\s+)?i\s+(?:want|need|would like)(?:\s+you)?\s+to\s+(?:help\s+me\s+)?(?:find|locate|look for)\s+(?:me\s+)?/i,
    /^(?:please\s+)?i(?:'m| am)\s+looking\s+for\s+/i,
    /^(?:where is|where are)\s+/i,
  ];
  for (const prefix of prefixes) target = target.replace(prefix, "");
  return target
    .trim()
    .replace(/^(?:a|an|the|my|some)\s+/i, "")
    .replace(/\s+please$/i, "")
    .trim();
}

function setTarget(target) {
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
  if (state.running && state.nextScanAt) {
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
        `<div class="registry-item ${item.target ? "target" : ""}"><span>${item.target ? "TARGET" : "OBSTACLE"}</span><b>${item.label}</b><small>${item.direction ? `${item.direction} · ` : ""}${item.score}% CONF.</small></div>`,
    )
    .join("");
}
function renderDetections(candidates) {
  const layer = $("detection-layer");
  layer.innerHTML = candidates
    .map((candidate) => {
      const [x, y, width, height] = candidate.bbox;
      return `<div class="detection-box target-detection" data-object-label="${candidate.label}" style="left:${x * 100}%;top:${y * 100}%;width:${width * 100}%;height:${height * 100}%"><span>${candidate.label.toUpperCase()} · ${Math.round(candidate.score * 100)}%</span></div>`;
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
  result.candidates.slice(0, 5).forEach((candidate) => {
    if (!state.registry.some((item) => item.label === candidate.label))
      state.registry.push({
        label: candidate.label,
        score: Math.round(candidate.score * 100),
        target: candidate.label
          .toLowerCase()
          .includes(targetInput.value.toLowerCase().split(" ").pop()),
      });
  });
  obstacles.forEach((obstacle) => {
    const key = `${obstacle.label}:${obstacle.direction}`;
    const existing = state.registry.find((item) => item.key === key);
    if (existing) {
      existing.score = Math.round(obstacle.confidence * 100);
    } else {
      state.registry.push({
        key,
        label: obstacle.label,
        direction: obstacle.direction,
        score: Math.round(obstacle.confidence * 100),
        target: false,
      });
    }
  });
  renderRegistry();
}

function applyNavigationDecision(result) {
  const decision = result.decision;
  const target = result.perception?.target;
  if (!decision) return;

  const now = Date.now();
  const announce =
    decision.action !== state.lastSpokenAction || now - state.lastSpokenAt >= 6000;
  setInstruction(
    decision.voiceInstruction,
    decision.reason,
    decision.confidence,
    announce,
  );
  if (announce) {
    state.lastSpokenAction = decision.action;
    state.lastSpokenAt = now;
  }

  $("target-distance").textContent = target?.visible ? target.direction : "—";
  const targetPositions = { LEFT: "25%", CENTER: "50%", RIGHT: "75%" };
  if (target?.visible && targetPositions[target.direction]) {
    $("target-marker").style.left = targetPositions[target.direction];
  }
}

async function analyzeFrame() {
  if (state.analyzing) return;
  if (!state.stream && !state.remoteFrame) {
    $("camera-label").textContent = "NO FRAME TO ANALYZE";
    setInstruction("Camera unavailable.", "Allow camera access before sending a frame to Gemini.", 0);
    return;
  }
  state.analyzing = true;
  const captureStarted = performance.now();
  try {
    if (state.remoteFrame) {
      const remoteImage = new Image();
      remoteImage.src = state.remoteFrame;
      await new Promise((resolve) => { remoteImage.onload = resolve; remoteImage.onerror = resolve; });
      canvas.width = remoteImage.naturalWidth || 640;
      canvas.height = remoteImage.naturalHeight || 480;
      canvas.getContext("2d").drawImage(remoteImage, 0, 0);
    } else {
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      canvas.getContext("2d").drawImage(video, 0, 0);
    }
    setScanStatus("PROCESSING", "PROCESSING CAMERA-RELATIVE SCENE");
    const image = canvas.toDataURL("image/jpeg", 0.85);
    const captureMs = performance.now() - captureStarted;
    const requestBody = {
      image_base64: image,
      target_object: targetInput.value,
      heading_deg: state.heading,
      capture_ms: captureMs,
    };
    const maskRequest = fetch("/api/traversability-frame", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
      .then(async (maskResponse) => {
        if (!maskResponse.ok) throw new Error(`Mask service returned ${maskResponse.status}`);
        return maskResponse.json();
      })
      .then(renderTraversability)
      .catch((error) => {
        $("traversability-readout").textContent = "MASK UNAVAILABLE";
        console.warn("Traversability overlay unavailable.", error);
      });
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
    await maskRequest;
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
    applyNavigationDecision(result);
    state.nextScanAt = Date.now() + SCAN_INTERVAL_MS;
    setScanStatus("WAITING 6S", `${result.decision.action} / WAITING 6S`);
    $("heading-value").textContent =
      `${String(Math.round(result.heading_deg + 360) % 360).padStart(3, "0")}°`;
    console.info("Navigation cycle timings", result.timings);
  } finally {
    state.analyzing = false;
  }
}
async function pairPhoneCamera() {
  const response = await fetch("/api/pairing", { method: "POST" });
  if (!response.ok) throw new Error("Could not create camera pairing");
  const pairing = await response.json();
  $("pairing-qr").src = pairing.qr_data_url;
  $("pairing-panel").hidden = false;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.remoteSocket = new WebSocket(`${protocol}://${location.host}/ws/pair/${pairing.session_id}?role=pc`);
  state.remoteSocket.onopen = () => setScanStatus("PHONE READY", "WAITING FOR PHONE CAMERA");
  state.remoteSocket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "frame") {
      state.remoteFrame = message.image_base64;
      $("remote-camera-frame").src = message.image_base64;
      $("remote-camera-frame").classList.add("active");
      state.cameraActive = true;
      $("connection-label").textContent = "PHONE CAMERA ACTIVE";
      $("camera-placeholder").classList.add("hidden");
      $("camera-placeholder").style.display = "none";
      setScanStatus("READY", "PHONE FRAME RECEIVED");
    }
  };
}
async function connectCamera() {
  if (state.cameraActive) return true;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable");
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
  } catch {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  }
  video.srcObject = state.stream;
  await video.play();
  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Camera stream has no video frames");
  }
  state.cameraActive = true;
  $("remote-camera-frame").classList.remove("active");
  $("camera-placeholder").classList.add("hidden");
  $("camera-placeholder").style.display = "none";
  $("connection-label").textContent = "LIVE CAMERA ACTIVE";
  setScanStatus("READY", "LIVE CAMERA / READY");
  return true;
}
async function startSession() {
  if (!targetInput.value.trim()) {
    speak("Tell me what you want to find first.");
    return;
  }
  state.running = !state.running;
  if (!state.running) {
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
  setScanStatus("CAPTURING", "CAPTURING LIVE FRAME");
  if (!state.startedAt) {
    state.startedAt = Date.now();
    state.timer = setInterval(updateClock, 1000);
  }
  setInstruction(
    "Scanning the room.",
    `Looking for your ${targetInput.value}.`,
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
    console.warn("Camera unavailable; using demo detections.", error);
  }
  try {
    await analyzeFrame();
  } catch (error) {
    if (error.status === 429 || error.message.includes("quota")) {
      state.running = false;
      clearInterval(state.scanTimer);
      $("session-state").textContent = "Quota reached";
      $("start-label").textContent = "Retry later";
      $("camera-label").textContent = "GEMINI QUOTA EXCEEDED";
      $("scan-status").textContent = "QUOTA STOPPED";
    } else {
      setScanStatus("RETRYING", "LIVE CAMERA / GEMINI RETRYING");
    }
    setInstruction("Vision analysis unavailable.", error.message, 0);
    console.warn("Vision analysis failed.", error);
  }
  clearInterval(state.scanTimer);
  state.scanTimer = setInterval(() => {
    if (
      state.running &&
      state.cameraActive &&
      !state.listening &&
      Date.now() >= state.backoffUntil
    ) {
      analyzeFrame().catch((error) => {
        if (error.status === 429 || error.message.includes("quota")) {
          state.running = false;
          clearInterval(state.scanTimer);
          $("session-state").textContent = "Quota reached";
          $("start-label").textContent = "Retry later";
          $("camera-label").textContent = "GEMINI QUOTA EXCEEDED";
          $("scan-status").textContent = "QUOTA STOPPED";
        } else {
          setScanStatus("RETRYING", "LIVE CAMERA / GEMINI RETRYING");
        }
        console.warn("Frame analysis failed.", error);
      });
    }
  }, SCAN_INTERVAL_MS);
}
cameraButton.addEventListener("click", async () => {
  try {
    await connectCamera();
    $("camera-placeholder").querySelector("strong").textContent = "Live camera connected";
    setInstruction("Camera ready.", "The live camera is connected and ready to scan.");
  } catch (error) {
    $("connection-label").textContent = "CAMERA ACCESS BLOCKED";
    $("camera-label").textContent = "ALLOW CAMERA ACCESS AND TRY AGAIN";
    $("camera-placeholder").querySelector(".placeholder-kicker").textContent = "PERMISSION NEEDED";
    $("camera-placeholder").querySelector("strong").textContent = "Camera access was blocked";
    setInstruction("Camera access blocked.", "Allow camera access and try again.", 0);
    console.warn("Camera unavailable.", error);
  }
});
pairButton.addEventListener("click", () => pairPhoneCamera().catch((error) => setInstruction("Pairing unavailable.", error.message, 0)));
closePairing.addEventListener("click", () => { $("pairing-panel").hidden = true; });
startButton.addEventListener("click", () =>
  startSession().catch((error) => {
    if (state.cameraActive) {
      $("camera-label").textContent = "LIVE CAMERA / GEMINI RETRYING";
      setInstruction("Vision analysis unavailable.", error.message, 0);
    } else {
      setInstruction("Camera unavailable.", "Allow camera access before starting the scan.", 0);
    }
    console.warn("Session failed.", error);
  }),
);
function resetVoiceControls() {
  state.listening = false;
  micButton.disabled = false;
  micButton.classList.remove("active");
  $("mic-button-label").textContent = "Tell me what to find";
  $("voice-pulse").classList.remove("listening");
}

async function useTranscript(transcript) {
  const recognizedTarget = cleanSpokenTarget(transcript);
  if (!recognizedTarget) throw new Error("I did not hear a target. Tap the button and try again.");

  setTarget(recognizedTarget);
  $("voice-label").textContent = `Finding: ${recognizedTarget}`;
  if (state.running) {
    setInstruction("Target updated.", `Now looking for your ${recognizedTarget}.`);
    await analyzeFrame();
  } else {
    await startSession();
  }
}

async function transcribeVoiceCommand(audioBlob) {
  micButton.disabled = true;
  $("mic-button-label").textContent = "Understanding…";
  $("voice-label").textContent = "Turning your speech into a target";
  const extension = audioBlob.type.includes("mp4") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", audioBlob, `voice-command.${extension}`);

  const response = await fetch("/api/transcribe", { method: "POST", body: form });
  if (!response.ok) {
    let detail = "I could not understand that. Please try again.";
    try {
      detail = (await response.json()).detail || detail;
    } catch {
      // Keep the accessible generic message for non-JSON server errors.
    }
    throw new Error(detail);
  }
  const result = await response.json();
  resetVoiceControls();
  await useTranscript(result.text);
}

micButton.addEventListener("click", async () => {
  if (state.listening) {
    if (voiceRecorder?.state === "recording") voiceRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !("MediaRecorder" in window)) {
    const message = "Voice input is unavailable in this browser.";
    $("voice-label").textContent = message;
    speak(message);
    return;
  }

  stopSpeaking();
  state.listening = true;
  micButton.classList.add("active");
  $("mic-button-label").textContent = "Listening… tap when done";
  $("voice-pulse").classList.add("listening");
  $("voice-label").textContent = "Say what you want me to find";

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const preferredTypes = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
    const chunks = [];
    voiceRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    voiceRecorder.addEventListener("stop", async () => {
      clearTimeout(voiceRecorderTimeout);
      stream.getTracks().forEach((track) => track.stop());
      const audioBlob = new Blob(chunks, { type: voiceRecorder.mimeType || "audio/webm" });
      voiceRecorder = null;
      try {
        await transcribeVoiceCommand(audioBlob);
      } catch (error) {
        resetVoiceControls();
        $("voice-label").textContent = error.message;
        speak(error.message);
        console.warn("Voice command failed.", error);
      }
    });
    voiceRecorder.start();
    voiceRecorderTimeout = setTimeout(() => {
      if (voiceRecorder?.state === "recording") voiceRecorder.stop();
    }, 8000);
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    resetVoiceControls();
    const message = error.name === "NotAllowedError"
      ? "Microphone access is blocked. Allow it and try again."
      : "I cannot access a microphone on this device.";
    $("voice-label").textContent = message;
    speak(message);
    console.warn("Could not record a voice command.", error);
  }
});
setTarget(targetInput.value);
renderRegistry();
