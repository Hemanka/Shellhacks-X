# Wayfinder

A voice-first blind navigation assistant prototype based on the included system design. FastAPI serves a browser mission console and sends camera frames to Gemini for structured object detection.

## Run locally

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Put your Gemini and ElevenLabs API keys in .env, or set DEMO_MODE=true for vision
uvicorn backend.main:app --reload
```

Open `http://127.0.0.1:8000`.

## Gemini setup

Create a Gemini API key in Google AI Studio and put it in `.env` as `GEMINI_API_KEY`. The key is read only by the backend and is not exposed to browser JavaScript. The backend also accepts the existing `GOOGLE_VISION_API_KEY` variable as a compatibility fallback, so the current key does not need to be renamed immediately.

The current endpoint asks Gemini for normalized bounding boxes and target matching. Depth, IMU pose, registry fusion, and A\* navigation are represented in the UI but need device-specific implementation and calibration before being used for real-world mobility assistance. Demo mode returns no detections and never fabricates objects.

## Phone camera pairing

Click **Use phone camera** on the PC, then scan the QR code with the phone. The phone opens `mobile.html`, captures its camera, and relays JPEG frames to the PC over a WebSocket. The PC continues sending the latest phone frame to Gemini.

Phone camera permissions require a secure context. For a phone on the same Wi-Fi, run the app behind HTTPS and set `PAIR_HOST`, `PAIR_SCHEME=https`, and `PAIR_PORT=443` in `.env`; an HTTPS tunnel such as ngrok is the simplest local setup. The PC and phone must be able to reach the generated URL.
## ElevenLabs text to speech

Set `ELEVENLABS_API_KEY` in `.env` to have every live guidance instruction spoken with ElevenLabs. The browser calls the local `/api/speech` endpoint, so the secret key remains on the backend. You can optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`; the defaults use the George voice and the low-latency `eleven_flash_v2_5` model. If ElevenLabs is unavailable or not configured, Wayfinder automatically falls back to the browser's built-in speech synthesis so guidance remains audible.

## Voice target selection

Target selection is voice-first. Tap **Tell me what to find**, say a natural command such as “help me find my keys,” then tap again when finished. Wayfinder records up to eight seconds, transcribes the command with ElevenLabs Scribe v2, extracts the target, confirms it on screen, and starts scanning automatically. The recording is sent through the backend so the ElevenLabs API key remains private. Microphone permission is required.

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
