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
};
const $ = (id) => document.getElementById(id);
const targetInput = $("target-input");
const startButton = $("start-button");
const cameraButton = $("camera-button");
const micButton = $("mic-button");
const video = $("camera-feed");
const canvas = document.createElement("canvas");

function speak(text) {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
}
function setInstruction(title, sub, confidence = null) {
  $("instruction").textContent = title;
  $("instruction-sub").textContent = sub;
  $("confidence-value").textContent =
    confidence === null ? "—" : `${Math.round(confidence * 100)}%`;
}
function updateClock() {
  if (!state.startedAt) return;
  const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
  $("session-time").textContent =
    `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
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
        `<div class="registry-item ${item.target ? "target" : ""}"><span>${item.target ? "TARGET" : "OBJ"}</span><b>${item.label}</b><small>${item.score}% CONF.</small></div>`,
    )
    .join("");
}
function renderDetections(candidates) {
  const layer = $("detection-layer");
  layer.innerHTML = candidates
    .map((candidate) => {
      const [x, y, width, height] = candidate.bbox;
      const targetWords = targetInput.value.toLowerCase().split(" ").filter((word) => word.length > 2);
      const isTarget = targetWords.some((word) => candidate.label.toLowerCase().includes(word));
      return `<div class="detection-box ${isTarget ? "target-detection" : ""}" data-object-label="${candidate.label}" style="left:${x * 100}%;top:${y * 100}%;width:${width * 100}%;height:${height * 100}%"><span>${candidate.label.toUpperCase()} · ${Math.round(candidate.score * 100)}%</span></div>`;
    })
    .join("");
}
function addSightings(result) {
  state.sightings += result.candidates.length;
  $("detection-count").textContent =
    `${state.sightings} sighting${state.sightings === 1 ? "" : "s"}`;
  renderDetections(result.candidates);
  $("frame-label").textContent = `FRAME ${result.frame_id.toUpperCase()}`;
  $("camera-label").textContent =
    `${result.candidates.length} OBJECT BOX${result.candidates.length === 1 ? "" : "ES"}`;
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
  renderRegistry();
}
async function analyzeFrame() {
  if (!state.stream) {
    $("camera-label").textContent = "NO FRAME TO ANALYZE";
    setInstruction("Camera unavailable.", "Allow camera access before sending a frame to Gemini.", 0);
    return;
  }
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext("2d").drawImage(video, 0, 0);
  const image = canvas.toDataURL("image/jpeg", 0.7);
  const response = await fetch("/api/analyze-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image_base64: image,
      target_object: targetInput.value,
      heading_deg: state.heading,
    }),
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
  addSightings(result);
  $("heading-value").textContent =
    `${String(Math.round(result.heading_deg + 360) % 360).padStart(3, "0")}°`;
  if (result.target_match.found) {
    setInstruction(
      "Target detected.",
      `I found a ${targetInput.value}. Keep facing this direction.`,
      result.target_match.match_confidence,
    );
    $("target-distance").textContent = "1.8m";
    $("target-marker").style.left = `${62 + (state.sightings % 4) * 4}%`;
    speak(`Target detected. Keep facing this direction.`);
  } else {
    setInstruction(
      "Turn right slowly.",
      "I am scanning the next part of the room.",
      0,
    );
    $("target-distance").textContent = "—";
  }
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
  $("camera-placeholder").classList.add("hidden");
  $("camera-placeholder").style.display = "none";
  $("connection-label").textContent = "LIVE CAMERA ACTIVE";
  $("camera-label").textContent = "LIVE CAMERA / READY";
  return true;
}
async function startSession() {
  state.running = !state.running;
  if (!state.running) {
    $("session-state").textContent = "Paused";
    $("start-label").textContent = "Resume finding";
    clearInterval(state.timer);
    clearInterval(state.scanTimer);
    return;
  }
  $("session-state").textContent = "Scanning";
  $("start-label").textContent = "Pause session";
  $("connection-label").textContent = "VISION LOOP ACTIVE";
  if (!state.startedAt) {
    state.startedAt = Date.now();
    state.timer = setInterval(updateClock, 1000);
  }
  setInstruction(
    "Scanning the room.",
    `Looking for your ${targetInput.value}.`,
  );
  speak(`Scanning for your ${targetInput.value}.`);
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
    } else {
      $("camera-label").textContent = "LIVE CAMERA / GEMINI RETRYING";
    }
    setInstruction("Vision analysis unavailable.", error.message, 0);
    console.warn("Vision analysis failed.", error);
  }
  clearInterval(state.scanTimer);
  state.scanTimer = setInterval(() => {
    if (state.running && state.cameraActive) {
      analyzeFrame().catch((error) => {
        if (error.status === 429 || error.message.includes("quota")) {
          state.running = false;
          clearInterval(state.scanTimer);
          $("session-state").textContent = "Quota reached";
          $("start-label").textContent = "Retry later";
          $("camera-label").textContent = "GEMINI QUOTA EXCEEDED";
        } else {
          $("camera-label").textContent = "LIVE CAMERA / GEMINI RETRYING";
        }
        console.warn("Frame analysis failed.", error);
      });
    }
  }, 10000);
}
cameraButton.addEventListener("click", async () => {
  try {
    await connectCamera();
    $("camera-placeholder").querySelector("strong").textContent = "Live camera connected";
  } catch (error) {
    $("connection-label").textContent = "CAMERA ACCESS BLOCKED";
    $("camera-label").textContent = "ALLOW CAMERA ACCESS AND TRY AGAIN";
    $("camera-placeholder").querySelector(".placeholder-kicker").textContent = "PERMISSION NEEDED";
    $("camera-placeholder").querySelector("strong").textContent = "Camera access was blocked";
    console.warn("Camera unavailable.", error);
  }
});
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
micButton.addEventListener("click", () => {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    $("voice-label").textContent = "Voice input is unavailable in this browser";
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.onstart = () => {
    micButton.classList.add("active");
    $("voice-pulse").classList.add("listening");
    $("voice-label").textContent = "Listening...";
  };
  recognition.onresult = (event) => {
    targetInput.value = event.results[0][0].transcript;
    $("voice-label").textContent = `Target: ${targetInput.value}`;
  };
  recognition.onend = () => {
    micButton.classList.remove("active");
    $("voice-pulse").classList.remove("listening");
  };
  recognition.start();
});
targetInput.addEventListener("input", () => {
  $("voice-label").textContent = targetInput.value
    ? `Target: ${targetInput.value}`
    : "Tap the mic or type a target";
});
renderRegistry();
