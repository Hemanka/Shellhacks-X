import base64
import json
import os
import socket
import uuid
from pathlib import Path
from typing import Any

import requests
import qrcode
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, File, UploadFile
from fastapi.responses import StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="Wayfinder Gemini API", version="0.1.0")
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models"
pairing_sessions: dict[str, dict[str, WebSocket | None]] = {}
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
MAX_VOICE_COMMAND_BYTES = 10 * 1024 * 1024


class FrameRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    target_object: str = Field(default="object", min_length=1, max_length=100)
    heading_deg: float = Field(default=0, ge=-360, le=360)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def demo_result(target: str, heading: float) -> dict[str, Any]:
    return {
        "frame_id": str(uuid.uuid4())[:8],
        "heading_deg": heading,
        "candidates": [],
        "target_match": {"found": False, "match_confidence": 0},
        "next_action": "allow_camera_or_configure_vision",
        "source": "demo",
    }


def decode_image(data: str) -> bytes:
    encoded = data.split(",", 1)[-1]
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Invalid camera image encoding") from exc


def label_matches(label: str, target: str) -> bool:
    requested = {part for part in target.lower().split() if len(part) > 2}
    detected = label.lower()
    return bool(requested & {detected}) or detected in target.lower()


def gemini_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_VISION_API_KEY")


@app.post("/api/pairing")
def create_pairing(request: Request) -> dict[str, str]:
    session_id = uuid.uuid4().hex[:12]
    pairing_sessions[session_id] = {"pc": None, "mobile": None}
    host = os.getenv("PAIR_HOST") or socket.gethostbyname(socket.gethostname())
    scheme = os.getenv("PAIR_SCHEME", "http")
    port = os.getenv("PAIR_PORT") or str(request.url.port or 8000)
    port_suffix = "" if (scheme == "https" and port == "443") else f":{port}"
    mobile_url = f"{scheme}://{host}{port_suffix}/mobile.html?session={session_id}"
    qr = qrcode.make(mobile_url)
    output = __import__("io").BytesIO()
    qr.save(output, format="PNG")
    return {"session_id": session_id, "mobile_url": mobile_url, "secure": str(scheme == "https").lower(), "qr_data_url": f"data:image/png;base64,{base64.b64encode(output.getvalue()).decode('ascii')}"}


@app.websocket("/ws/pair/{session_id}")
async def pairing_socket(websocket: WebSocket, session_id: str, role: str = "mobile") -> None:
    if session_id not in pairing_sessions or role not in {"pc", "mobile"}:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    pairing_sessions[session_id][role] = websocket
    try:
        while True:
            message = await websocket.receive_json()
            if role == "mobile" and message.get("type") == "frame":
                pc = pairing_sessions[session_id].get("pc")
                if pc:
                    await pc.send_json({"type": "frame", "image_base64": message.get("image_base64", "")})
    except (WebSocketDisconnect, RuntimeError):
        pairing_sessions.get(session_id, {})[role] = None
def elevenlabs_key() -> str | None:
    return os.getenv("ELEVENLABS_API_KEY")


@app.get("/api/health")
def health() -> dict[str, str | bool]:
    configured = bool(gemini_key())
    return {
        "status": "ok",
        "gemini_configured": configured,
        "elevenlabs_configured": bool(elevenlabs_key()),
        "demo_mode": os.getenv("DEMO_MODE", "false").lower() == "true",
    }


@app.post("/api/speech")
def create_speech(payload: SpeechRequest) -> Response:
    """Generate a short spoken command without exposing the API key to the browser."""
    api_key = elevenlabs_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="ElevenLabs text-to-speech is not configured")

    voice_id = os.getenv("ELEVENLABS_VOICE_ID", DEFAULT_ELEVENLABS_VOICE_ID)
    model_id = os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5")
    try:
        response = requests.post(
            f"{ELEVENLABS_URL}/{voice_id}",
            params={"output_format": "mp3_44100_128"},
            headers={
                "xi-api-key": api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={"text": payload.text.strip(), "model_id": model_id},
            timeout=20,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        detail = "ElevenLabs could not generate speech"
        if exc.response is not None:
            detail = f"ElevenLabs request failed ({exc.response.status_code})"
        raise HTTPException(status_code=502, detail=detail) from exc

    return Response(
        content=response.content,
        media_type=response.headers.get("content-type", "audio/mpeg"),
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/transcribe")
def transcribe_voice_command(file: UploadFile = File(...)) -> dict[str, str]:
    """Transcribe a short voice command while keeping the ElevenLabs key server-side."""
    api_key = elevenlabs_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="ElevenLabs speech-to-text is not configured")
    if file.content_type and not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=415, detail="The uploaded command must be an audio file")

    audio = file.file.read(MAX_VOICE_COMMAND_BYTES + 1)
    if not audio:
        raise HTTPException(status_code=400, detail="The voice command was empty")
    if len(audio) > MAX_VOICE_COMMAND_BYTES:
        raise HTTPException(status_code=413, detail="The voice command is too large")

    try:
        response = requests.post(
            ELEVENLABS_STT_URL,
            headers={"xi-api-key": api_key},
            files={
                "file": (
                    file.filename or "voice-command.webm",
                    audio,
                    file.content_type or "audio/webm",
                )
            },
            data={
                "model_id": os.getenv("ELEVENLABS_STT_MODEL_ID", "scribe_v2"),
                "language_code": "eng",
                "tag_audio_events": "false",
                "timestamps_granularity": "none",
            },
            timeout=30,
        )
        response.raise_for_status()
        transcript = response.json().get("text", "").strip()
    except requests.RequestException as exc:
        detail = "ElevenLabs could not transcribe the voice command"
        if exc.response is not None:
            detail = f"ElevenLabs transcription failed ({exc.response.status_code})"
        raise HTTPException(status_code=502, detail=detail) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="ElevenLabs returned an invalid transcript") from exc

    if not transcript:
        raise HTTPException(status_code=422, detail="No speech was detected")
    return {"text": transcript}


@app.post("/api/analyze-frame")
def analyze_frame(payload: FrameRequest) -> dict[str, Any]:
    api_key = gemini_key()
    if os.getenv("DEMO_MODE", "false").lower() == "true" or not api_key:
        return demo_result(payload.target_object, payload.heading_deg)

    image_bytes = decode_image(payload.image_base64)
    model = os.getenv("VISION_MODEL", "gemini-3.5-flash-lite")
    gemini_url = f"{GEMINI_BASE_URL}/{model}:generateContent"
    body = {
        "contents": [{"parts": [
            {"text": (
                "Analyze this camera frame for navigation. Look only for the requested target object "
                f"{payload.target_object!r}. Do not detect, label, or return any other object. "
                "Return only valid JSON matching this schema: "
                '{"objects":[{"label":"string","confidence":0.0,"bbox":[x,y,width,height]}]}. '
                "Use normalized coordinates from 0 to 1. Return at most one tight bounding box for the best "
                "matching target. If the target is not clearly visible, return {\"objects\":[]} and do not invent it."
            )},
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(image_bytes).decode("ascii")}},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.1,
        },
    }
    try:
        response = requests.post(
            gemini_url,
            params={"key": api_key},
            json=body,
            timeout=12,
        )
        response.raise_for_status()
        raw = response.json()
        text = raw["candidates"][0]["content"]["parts"][0]["text"]
        objects = json.loads(text).get("objects", [])
    except requests.RequestException as exc:
        detail = "Gemini could not analyze this frame"
        if exc.response is not None:
            detail = f"Gemini request failed ({exc.response.status_code}): {exc.response.text[:240]}"
            if exc.response.status_code == 429:
                raise HTTPException(status_code=429, detail="Gemini quota exceeded. Wait for the quota reset or use a key with available quota.") from exc
        raise HTTPException(status_code=502, detail=detail) from exc
    except (KeyError, IndexError, ValueError) as exc:
        raise HTTPException(status_code=502, detail="Gemini returned an unexpected response format") from exc

    candidates = []
    for item in objects:
        bbox = item.get("bbox", [])
        if len(bbox) != 4:
            continue
        candidates.append({
            "label": item.get("label", "unknown"),
            "score": round(float(item.get("confidence", 0)), 3),
            "bbox": [max(0, min(1, float(value))) for value in bbox],
        })

    matches = [candidate for candidate in candidates if label_matches(candidate["label"], payload.target_object)]
    candidates = matches[:1]
    confidence = max((candidate["score"] for candidate in matches), default=0)
    return {
        "frame_id": str(uuid.uuid4())[:8],
        "heading_deg": payload.heading_deg,
        "candidates": candidates,
        "target_match": {"found": bool(matches), "match_confidence": confidence},
        "next_action": None if matches else "turn_right_45",
        "source": "gemini",
    }


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
