# Wayfinder

A voice-first blind navigation assistant prototype. The phone handles camera and microphone permissions, voice input, and spoken output. The Windows browser dashboard runs the navigation loop and shows diagnostics.

## Start on Windows

Double-click **Start-Wayfinder.cmd** to open the local dashboard in the default
Windows browser. For phone use, **Start-Wayfinder-Phone.cmd** starts the same
dashboard plus a temporary public Cloudflare HTTPS tunnel. This shares the app
through Cloudflare so the phone can access its camera and microphone securely.
The dashboard creates its QR code automatically. Keep the launcher running.

Scan the QR code, tap **Allow camera & microphone** on the phone, and then tap
**Tap to speak**. The phone has no camera preview, map, model output, or debug
panels. Instructions play on the phone; the Windows dashboard stays silent.

Double-click **Stop-Wayfinder.cmd** to stop the server and tunnel. For an existing
HTTPS endpoint, use `./Start-Wayfinder.ps1 -PhoneUrl https://your-host.example`.
The optional HTTPS field on the dashboard can also regenerate the QR link.

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

The diagnostic traversability overlay runs independently, at most once per
second and with one request in flight. Guidance never waits for the overlay.
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
Losing the pairing or fresh camera frames pauses guidance. The phone supports
repeating a cue and pausing/resuming without exposing debug controls.

Phone camera and microphone permissions require HTTPS. The phone launcher can
create a temporary tunnel, or set `PAIR_BASE_URL` to an existing HTTPS endpoint.
Legacy `PAIR_HOST`, `PAIR_SCHEME`, and `PAIR_PORT` remain supported. The PC and
phone must both be able to reach the generated address.
## ElevenLabs text to speech

Set `ELEVENLABS_API_KEY` in `.env` to have every live guidance instruction spoken with ElevenLabs. The browser calls the local `/api/speech` endpoint, so the secret key remains on the backend. You can optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`; the defaults use the George voice and the low-latency `eleven_flash_v2_5` model. If ElevenLabs is unavailable or not configured, Wayfinder automatically falls back to the browser's built-in speech synthesis so guidance remains audible.

## Voice target selection

On the phone, tap **Tap to speak**, say “help me find my keys,” then tap again to
finish. Wayfinder records up to eight seconds, transcribes with ElevenLabs
Scribe v2, sends the transcript to the dashboard, and starts navigation. The API
key remains on the backend. The dashboard also has a manual target field for
debugging when voice input is unavailable.

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
