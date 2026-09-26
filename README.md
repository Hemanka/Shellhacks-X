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

## ElevenLabs text to speech

Set `ELEVENLABS_API_KEY` in `.env` to have every live guidance instruction spoken with ElevenLabs. The browser calls the local `/api/speech` endpoint, so the secret key remains on the backend. You can optionally set `ELEVENLABS_VOICE_ID` and `ELEVENLABS_MODEL_ID`; the defaults use the George voice and the low-latency `eleven_flash_v2_5` model. If ElevenLabs is unavailable or not configured, Wayfinder automatically falls back to the browser's built-in speech synthesis so guidance remains audible.

## Voice target selection

Target selection is voice-first. Tap **Tell me what to find**, say a natural command such as “help me find my keys,” then tap again when finished. Wayfinder records up to eight seconds, transcribes the command with ElevenLabs Scribe v2, extracts the target, confirms it on screen, and starts scanning automatically. The recording is sent through the backend so the ElevenLabs API key remains private. Microphone permission is required.
