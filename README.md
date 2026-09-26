# Wayfinder

A voice-first blind navigation assistant prototype based on the included system design. FastAPI serves a browser mission console and sends camera frames to Gemini for structured object detection.

## Run locally

```powershell
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Put your Gemini API key in .env, or set DEMO_MODE=true
uvicorn backend.main:app --reload
```

Open `http://127.0.0.1:8000`.

## Gemini setup

Create a Gemini API key in Google AI Studio and put it in `.env` as `GEMINI_API_KEY`. The key is read only by the backend and is not exposed to browser JavaScript. The backend also accepts the existing `GOOGLE_VISION_API_KEY` variable as a compatibility fallback, so the current key does not need to be renamed immediately.

The current endpoint asks Gemini for normalized bounding boxes and target matching. Depth, IMU pose, registry fusion, and A\* navigation are represented in the UI but need device-specific implementation and calibration before being used for real-world mobility assistance. Demo mode returns no detections and never fabricates objects.
