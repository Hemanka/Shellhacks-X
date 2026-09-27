# SeekR

A voice-first blind navigation assistant prototype. The phone handles camera and microphone permissions, voice input, and spoken output. The Windows browser dashboard runs the navigation loop and shows diagnostics.

## Start on Windows

Double-click **Start-SeekR.cmd** to open the dashboard and start a temporary
Cloudflare HTTPS tunnel. The dashboard remains at `http://127.0.0.1:8000`; the
QR code uses the tunnel's HTTPS address so phone camera and microphone
permissions work. **Start-SeekR-Phone.cmd** does the same. The phone address
is randomly assigned and changes when the tunnel restarts. Keep the launcher
running while using the phone. The tunnel makes this app reachable through a
public HTTPS URL for that session; do not share the QR code with people you do
not want accessing the session.

Scan the QR code and tap **Start SeekR** once on the phone to allow camera and
microphone access. Keep the page open while using it. Say an item target such
as “red cup” or “black hoodie”; later, say “Hey SeekR” before a new target or
control command. Answer a spoken question directly. The phone has no camera
preview, map, model output, or debug panels. Instructions play on the phone;
the Windows dashboard stays silent.

Double-click **Stop-SeekR.cmd** to stop the server and tunnel. To run local
debug mode without a phone tunnel, use `./Start-SeekR.ps1 -NoTunnel`. For an
existing HTTPS endpoint, use `./Start-SeekR.ps1 -PhoneUrl https://your-host.example`.
The optional HTTPS field on the dashboard can also regenerate the QR link. A
stable branded HTTPS address requires a domain and a configured Cloudflare
tunnel; the automatic quick tunnel provides a temporary address instead.

The launcher installs the small dashboard dependencies from
`requirements-web.txt`. Add your API keys to `.env` or `.env.local` before live use. To enable
the SegFormer overlay, install the full model dependencies separately:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
# If .env does not exist, copy .env.example to .env and replace the placeholder keys.
```

The dashboard is at `http://127.0.0.1:8000`. It shows the live camera and candidate
mask, observed sectors and objects, target, selected action and scores, input and
analysis rates, Gemini/mask/capture/decision times, frame age, quota cooldown,
permission states, speech input/output and playback state, errors, an event log,
and raw responses. **Export debug log** downloads a local JSON snapshot, without
camera images or API keys. Runtime server/tunnel logs are in ignored `.runtime/`.
No events or camera images are persisted by the dashboard unless you export.

## Live update cadence

Navigation starts a fresh analysis as soon as the previous request finishes,
with a 250 ms minimum between starts (up to four analyses per second). Only one
navigation request is in flight; slow Gemini responses do not create a frame
queue. Actual guidance frequency depends on Gemini and network latency. Existing
Gemini image quality, perception prompts, and navigation decisions are unchanged.

The diagnostic traversability overlay runs independently, with one request in
flight and a 500 ms minimum interval between starts. The segmentation model
loads and warms in the background after server startup; the dashboard reports
its readiness and shows total mask processing separately from model inference.
Guidance never waits for the overlay.
Phone cameras send up to five frames per second, skipping sends when the socket
is backed up. Duplicate or stale phone frames are not reanalyzed. API quota
cooldowns still apply, and results from a paused or changed session are ignored.

The browser console reports `Navigation response latency` alongside the existing
server timing breakdown. Repeat voice cues retain their six-second spacing;
changed actions can still be announced immediately.

Run the dependency-free browser-loop regression tests with Node.js:

```powershell
node --test tests/live-loop.test.cjs tests/phone-flow.test.cjs tests/dashboard-flow.test.cjs
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
```

## Navigation instructions

Each live navigation decision is converted locally into one displayed and spoken
instruction. Examples include “Take one small step forward, then stop,” “Obstacle
ahead. Turn slightly right, then stop,” and “Stop. Hold your position.” The app
checks the next camera view before choosing the next instruction. This formatter
adds no Gemini call and does not change the navigation engine's selected action.

The API's `guidance` field separates the short spoken cue from supporting text
and diagnostic reasoning. Changed actions or obstacle context are announced
immediately; repeated equivalent frames do not restart speech. The existing
ElevenLabs voice and browser fallback still deliver the instructions.

This branch selects camera-relative next steps. It does not yet calculate a full
waypoint route, track distance traveled, or automatically establish arrival.
Instructions therefore do not invent distances, turn angles, or future turns.

Run instruction tests with `python -m unittest discover -s tests -p 'test_guidance.py'`.

## Gemini setup

Create a Gemini API key in Google AI Studio and put it in `.env` as `GEMINI_API_KEY`. The key is read only by the backend and is not exposed to browser JavaScript. The backend also accepts the existing `GOOGLE_VISION_API_KEY` variable as a compatibility fallback, so the current key does not need to be renamed immediately.

The current endpoint asks Gemini for target direction and the state of three
camera-relative sectors. It does not measure depth or compute an A* waypoint
route. Demo mode returns uncertainty rather than fabricated detections.

## Phone camera pairing

The persistent dashboard QR code opens `mobile.html`. Camera frames, voice
transcripts, permission changes, and audio playback status travel from the phone
to its paired dashboard. Guidance and session state travel back to the phone.
Losing pairing pauses guidance; interrupted frame delivery waits for automatic recovery. The phone supports
repeating a cue and pausing/resuming without exposing debug controls.

Phone camera and microphone permissions require HTTPS. The phone launcher can
create a temporary tunnel, or set `PAIR_BASE_URL` to an existing HTTPS endpoint.
Legacy `PAIR_HOST`, `PAIR_SCHEME`, and `PAIR_PORT` remain supported. The PC and
phone must both be able to reach the generated address.
## ElevenLabs text to speech

Set `ELEVENLABS_API_KEY` in `.env` to have every live guidance instruction spoken with ElevenLabs. The browser calls the local `/api/speech` endpoint, so the secret key remains on the backend. You can optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`; the defaults use the George voice and the low-latency `eleven_flash_v2_5` model. If ElevenLabs is unavailable or not configured, SeekR automatically falls back to the browser's built-in speech synthesis so guidance remains audible.

## Voice target selection

On the phone, tap **Start SeekR** once, then say “red cup” or “black hoodie.”
After that first target, say “Hey SeekR” before giving a new target. The phone
keeps hands-free speech recognition active and sends matching
wake-word commands or answers to spoken prompts to the dashboard. Browsers
without built-in speech recognition use voice activity detection and the
backend’s ElevenLabs Scribe transcription endpoint. Keep the phone page in the
foreground; mobile browsers may suspend microphone recognition when the page is
backgrounded or the screen is locked. The dashboard also has a manual target
field for debugging when voice input is unavailable.

## Phase 1 candidate traversability mask

Generate a human-reviewable semantic-segmentation visualization from an indoor
photograph:

```bash
.venv/bin/python -m backend.traversability.debug test.jpg
```

The first run downloads the pretrained SegFormer-B0 ADE20K checkpoint. The
command writes `walkable-debug.png` in the current directory and prints the
candidate-walkable, blocked, unknown, and non-walkable pixel percentages plus
inference time. Green means candidate walkable—not guaranteed safe.

Optional detector output can override the segmentation using normalized
bounding boxes and configurable planning padding:

```bash
.venv/bin/python -m backend.traversability.debug test.jpg \
  --obstacles detections.json --obstacle-padding 0.10
```

```json
{
  "obstacles": [
    {"label": "chair", "bbox": [0.3, 0.35, 0.6, 0.9], "confidence": 0.92}
  ]
}
```

This Phase 1 tool is deliberately isolated from the navigation engine, A*, and
spoken guidance until real-room masks have been reviewed.

## Stateful navigation and pickup

The Windows dashboard owns a separate navigation controller for each paired
session. Gemini returns observations; the controller handles SEARCH, ALIGN,
APPROACH, RECOVER, HOLD, PICKUP, and COMPLETE. Backend candidate scoring has no
shared cross-session target history.

- Alignment enters within horizontal image coordinates 0.30–0.70 and stays
  aligned within 0.20–0.80. Two consistent outside observations change direction.
- Each walking cue is one bounded step. Duplicate frames cannot authorize steps;
  ordinary repeated cues are suppressed for eight seconds.
- Target occupancy is separate from approach and reach access. A bottle on the
  floor stays occupied space but can lead to pickup instead of a detour.
- Two usable reach assessments, confidence >= 0.8, clear reach evidence, and a
  pickup-suitable target enable coarse pickup cues. A visible hand is optional.
- Say “Hey SeekR” before a new target or control command. Say “exit task” to
  stop navigation. Answers to spoken
  questions (such as “yes,” “no,” “too far,” or “got it”) are accepted directly.
  Say “pause,” “resume,” or “repeat” by voice.

### Recovery and phone sensors

The permission button also requests orientation access when the browser needs
it. Sensor denial leaves visual search available. Frame sequence, phone-monotonic
capture time, stream ID, and orientation travel together. Orientation updates run
at up to 10 Hz; current phone timestamps anchor dashboard evidence age without
assuming synchronized Windows and phone wall clocks.

Recovery remembers the last viewing direction, not a metric room location. It
corrects after a >15° error persists for 300 ms, settles below 8°, and speaks at
most every three seconds. Memory expires after 12 seconds, sensor staleness over
500 ms, reference/screen changes, reconnection, target changes, or a walking cue.
Nearly vertical camera poses disable horizontal bearing corrections.

### Obstacle feedback and freshness

A fresh, confidence >=0.8 obstacle assessment must explicitly identify apparent
close proximity, intrusion, and evidence to trigger a named warning. This is
not measured distance or continuous collision detection. The NVIDIA mask does
not supply depth and cannot independently trigger proximity warnings.

The phone requests a 200/100/200 ms double vibration pulse immediately, then
speaks the warning. Unsupported/rejected vibration uses a locally generated tone.
Feedback requires browser interaction; API acceptance does not prove a physical
vibration occurred. A hazard interrupts and discards voice recording so warning
audio cannot become a command. Repeat alerts require newer evidence and at least
four seconds. Two clear assessments remove the hazard; age alone never clears it.

Walking, pickup, and close-proximity cues have no wall-clock expiration. New
movement requires a frame captured after the previous movement cue. Substantial
heading changes invalidate pending views. Pause, a new target, disconnection, or
replacement guidance cancels pending speech. Blank frames and service failures have separate
messages. Rate-limited Gemini models are temporarily skipped on subsequent frames. The dashboard shows why a cue was held or suppressed.

Thresholds are centralized in `frontend/navigation-controller.js` DEFAULTS.
The dashboard displays stage, evidence, memory, hazard, and sensor/haptic status.
Debug exports contain bounded observation history (100 items / 60 seconds),
without camera image bytes. Restart/reload loses this in-memory state.

### Verification

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.cjs
```

Automated suites cover schema compatibility, bounds, replayed navigation, phone
feedback, sensor geometry, freshness, and dashboard-to-phone messages. Physical
acceptance still requires iPhone Safari and Android Chrome: verify the named
warning and vibration/tone, portrait/landscape overshoot recovery, camera tilt,
permission denial, and floor-object pickup with a separate obstacle nearby.

Camera delivery tolerates gaps up to ten seconds before issuing one waiting message; fresh frames resume analysis automatically without a Resume tap. Phone uploads are capped at 960 pixels on the long edge to reduce tunnel congestion. Close warnings require separate proximity confidence of at least 0.85; object recognition confidence alone does not imply distance. Target-support objects (such as a trash can holding a cup) remain occupied space for walking, but clear, consistently reachable targets can transition to pickup on that surface. These are monocular estimates, not measured distances.
Supported targets use a general approach-stop-reach sequence: distant target supports do not block an explicitly clear next step, while close/uncertain supports and separate barriers still prevent walking. This applies by relationship, not by furniture name.

Incremental guidance update: model results and modern speech cues no longer expire solely with elapsed time. Each movement cue establishes a capture boundary; the next movement needs a frame captured after it. Duplicate/out-of-order frames and results invalidated by a substantial comparable heading change (25 degrees) are rejected. Pause, target changes and disconnection still cancel guidance. The ten-second camera-delivery watchdog is separate from result validity. Orientation-memory age limits remain for recovery only. No step-completion or translation detector is implemented; the user follows the take-one-step-then-pause workflow.

### NVIDIA-driven approach
The dashboard enables routeMode: local pixel masks supply the walking/turning choice independently of Gemini. The overlay preserves the segmenter's per-pixel contours instead of painting rectangular detector boxes over the floor. A 96x128 planning grid follows those contours with round clearance buffers; unknown cells carry a higher cost, while classified obstacles remain closed. Mask and route updates run independently at up to four frames per second. They use the most recent Gemini-confirmed target location, but stop when that location is over five seconds old or the phone has turned substantially; step cues no longer wait for a new Gemini response. The yellow line is solid for a confirmed route and dashed for an estimate. The phone speaks a replacement only when the mask changes substantially, the route moves substantially, or the immediate action changes. Gemini continues to supply target identity/location and pickup/reach context, and ElevenLabs speaks each route instruction on the paired phone. These image-space routes do not measure body clearance, distance, drop-offs, or overhead hazards; physical room trials remain necessary.
Reach handoff: likely_reachable does not qualify for pickup or stop NVIDIA; easily_reachable with a comfortable grasp and no stepping, leaning or stretching is required. A reach-check pause requires pickup suitability, clear reach, evidence and no separate reach obstruction. In route mode, two consistent easy-reach observations trigger one final short, mask-guided step; the first fresh clear easy-reach observation after that step announces arrival and asks for voice confirmation. Say too far or cannot reach it to request another mask-guided approach step before rechecking reach. The correction never bypasses a blocked floor route.
