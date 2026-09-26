import base64
import json
import os
import re
import uuid
from io import BytesIO
from pathlib import Path
from time import perf_counter, time
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from .pairing import router as pairing_router
from .navigation.navigator import CameraRelativeNavigator
from .navigation.guidance import guidance_for_step
from .navigation.types import NavigationAction, NavigationDecision, PerceptionState
from .perception import (
    GEMINI_PERCEPTION_PROMPT,
    GEMINI_PERCEPTION_SCHEMA,
    parse_gemini_perception,
    perception_to_dict,
    uncertain_perception,
)
from .traversability.debug import overlay_data_url
from .traversability.segmenter import SegformerTraversabilitySegmenter

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / ".env.local")

app = FastAPI(title="Wayfinder Gemini API", version="0.1.0")
app.include_router(pairing_router)
GEMINI_URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_GEMINI_MODELS = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite")
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
MAX_VOICE_COMMAND_BYTES = 10 * 1024 * 1024
navigation_engine = CameraRelativeNavigator(
    debug=os.getenv("NAVIGATION_DEBUG", "false").lower() == "true"
)
navigation_target: str | None = None
traversability_segmenter = SegformerTraversabilitySegmenter()

VOICE_INSTRUCTIONS = {
    NavigationAction.FORWARD: "Move forward one small step.",
    NavigationAction.TURN_LEFT: "Turn slightly left.",
    NavigationAction.TURN_RIGHT: "Turn slightly right.",
    NavigationAction.HOLD: "Hold your position.",
    NavigationAction.REACQUIRE: "Hold while I check the route.",
    NavigationAction.ARRIVED: "You have reached your destination.",
}


class FrameRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    target_object: str = Field(default="object", min_length=1, max_length=100)
    heading_deg: float = Field(default=0, ge=-360, le=360)
    capture_ms: float = Field(default=0, ge=0, le=60_000)


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


def serialize_decision(decision: NavigationDecision) -> dict[str, Any]:
    return {
        "action": decision.action.value,
        "confidence": decision.confidence,
        "reason": decision.reason,
        "shouldReplan": decision.should_replan,
        "voiceInstruction": VOICE_INSTRUCTIONS[decision.action],
        "candidateScores": {
            action.value: score for action, score in decision.candidate_scores.items()
        },
    }


def gemini_models() -> tuple[str, ...]:
    configured = os.getenv("GEMINI_MODELS", "")
    models = tuple(item.strip() for item in configured.split(",") if item.strip())
    return models or DEFAULT_GEMINI_MODELS


def gemini_retry_after_ms(response: requests.Response | None) -> int:
    """Read Google's retry hint, with a conservative fallback cooldown."""
    if response is None:
        return 30_000
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return max(6_000, int(float(retry_after) * 1000))
        except ValueError:
            pass
    try:
        error = response.json().get("error", {})
        details = error.get("details", [])
        retry_delay = next(
            (
                detail.get("retryDelay")
                for detail in details
                if isinstance(detail, dict) and detail.get("retryDelay")
            ),
            None,
        )
        message = error.get("message", "")
    except (TypeError, ValueError):
        retry_delay = None
        message = ""
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)s", retry_delay or message)
    if match:
        return max(6_000, int(float(match.group(1)) * 1000))
    return 30_000


def navigation_result(
    payload: FrameRequest,
    perception: PerceptionState,
    decision: NavigationDecision,
    *,
    source: str,
    started: float,
    gemini_ms: float = 0,
    parsing_ms: float = 0,
    error: str | None = None,
    model: str | None = None,
    rate_limited: bool = False,
    retry_after_ms: int = 0,
) -> dict[str, Any]:
    target = perception.target
    guidance = guidance_for_step(decision, perception)
    result = {
        "frame_id": str(uuid.uuid4())[:8],
        "heading_deg": payload.heading_deg,
        "candidates": [],
        "target_match": {
            "found": bool(target and target.visible),
            "match_confidence": target.confidence if target else 0,
        },
        "perception": perception_to_dict(perception),
        "decision": serialize_decision(decision),
        "guidance": guidance.to_dict(),
        "next_action": decision.action.value,
        "source": source,
        "model": model,
        "rateLimited": rate_limited,
        "retryAfterMs": retry_after_ms,
        "timings": {
            "capture_ms": round(payload.capture_ms, 2),
            "gemini_ms": round(gemini_ms, 2),
            "parsing_ms": round(parsing_ms, 2),
            "decision_ms": round(decision.latency_ms, 3),
            "total_ms": round((perf_counter() - started) * 1000, 2),
        },
    }
    if error:
        result["perception_error"] = error
    sectors = perception.sectors
    target_direction = (
        target.direction.value if target and target.visible else "NOT_VISIBLE"
    )
    print(
        f"Gemini: {gemini_ms:.1f} ms | JSON validation: {parsing_ms:.1f} ms | "
        f"Decision engine: {decision.latency_ms:.3f} ms | "
        f"Total cycle: {result['timings']['total_ms']:.1f} ms | "
        f"Source: {source} | Target: {target_direction} | "
        f"Sectors: {sectors.left.status.value}/{sectors.center.status.value}/"
        f"{sectors.right.status.value} | Action: {decision.action.value} | "
        f"Error: {error or 'none'}"
    )
    return result


def decode_image(data: str) -> bytes:
    encoded = data.split(",", 1)[-1]
    try:
        return base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise HTTPException(status_code=400, detail="Invalid camera image encoding") from exc


def traversability_result(image_bytes: bytes) -> dict[str, Any]:
    """Run Phase 1 semantic segmentation and serialize its live debug overlay."""
    started = perf_counter()
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            mask = traversability_segmenter.segment(source.convert("RGB"))
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid camera image") from exc
    except Exception as exc:
        print(f"Traversability segmentation failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail="Local traversability segmentation is unavailable",
        ) from exc

    stats = {name: round(value, 2) for name, value in mask.percentages().items()}
    total_ms = (perf_counter() - started) * 1000
    print(
        f"Traversability: {mask.inference_ms:.1f} ms inference | "
        f"{stats['candidate_walkable']:.1f}% candidate | "
        f"{stats['unknown']:.1f}% unknown | {total_ms:.1f} ms total"
    )
    return {
        "overlayDataUrl": overlay_data_url(mask),
        "percentages": stats,
        "inferenceMs": round(mask.inference_ms, 2),
        "totalMs": round(total_ms, 2),
        "width": mask.width,
        "height": mask.height,
        "label": "candidate traversable — not verified safe",
    }


def label_matches(label: str, target: str) -> bool:
    requested = {part for part in target.lower().split() if len(part) > 2}
    detected = label.lower()
    return bool(requested & {detected}) or detected in target.lower()


def gemini_key() -> str | None:
    return os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_VISION_API_KEY")


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
    started = perf_counter()
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

    latency_ms = (perf_counter() - started) * 1000
    print(f"Voice request: {latency_ms:.1f} ms")
    return Response(
        content=response.content,
        media_type=response.headers.get("content-type", "audio/mpeg"),
        headers={
            "Cache-Control": "no-store",
            "Server-Timing": f"elevenlabs;dur={latency_ms:.1f}",
        },
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
    global navigation_target

    started = perf_counter()
    if navigation_target != payload.target_object:
        navigation_engine.reset()
        navigation_target = payload.target_object

    api_key = gemini_key()
    if os.getenv("DEMO_MODE", "false").lower() == "true" or not api_key:
        perception = uncertain_perception(payload.target_object)
        decision = navigation_engine.decide(perception)
        reason = "Gemini is not configured" if not api_key else "Gemini demo mode is enabled"
        return navigation_result(
            payload,
            perception,
            decision,
            source="demo",
            started=started,
            error=reason,
        )

    image_bytes = decode_image(payload.image_base64)
    body = {
        "contents": [{"parts": [
            {"text": GEMINI_PERCEPTION_PROMPT.format(target=payload.target_object)},
            {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(image_bytes).decode("ascii")}},
        ]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": GEMINI_PERCEPTION_SCHEMA,
            "mediaResolution": "MEDIA_RESOLUTION_HIGH",
            "temperature": 0.1,
        },
    }
    gemini_started = perf_counter()
    gemini_ms = 0.0
    parsing_ms = 0.0
    source = "gemini"
    perception_error = None
    model_used = None
    rate_limited = False
    retry_after_ms = 0
    try:
        models = gemini_models()
        response = None
        for index, model in enumerate(models):
            model_used = model
            response = requests.post(
                GEMINI_URL_TEMPLATE.format(model=model),
                params={"key": api_key},
                json=body,
                timeout=12,
            )
            if response.status_code != 429 or index == len(models) - 1:
                break
            print(f"Gemini model {model} was rate limited; trying {models[index + 1]}.")
        assert response is not None
        response.raise_for_status()
        gemini_ms = (perf_counter() - gemini_started) * 1000
        raw = response.json()
        text = raw["candidates"][0]["content"]["parts"][0]["text"]
        parsing_started = perf_counter()
        perception, perception_error = parse_gemini_perception(
            json.loads(text),
            payload.target_object,
            timestamp=time(),
        )
        parsing_ms = (perf_counter() - parsing_started) * 1000
        if perception_error:
            source = "fallback"
    except requests.RequestException as exc:
        gemini_ms = (perf_counter() - gemini_started) * 1000
        perception_error = "Gemini could not analyze this frame"
        if exc.response is not None:
            perception_error = f"Gemini request failed ({exc.response.status_code})"
            if exc.response.status_code == 429:
                rate_limited = True
                retry_after_ms = gemini_retry_after_ms(exc.response)
                perception_error = "Gemini quota is temporarily exhausted"
        perception = uncertain_perception(payload.target_object)
        source = "rate_limit" if rate_limited else "fallback"
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        gemini_ms = gemini_ms or (perf_counter() - gemini_started) * 1000
        perception_error = f"Gemini returned invalid structured perception: {exc}"
        perception = uncertain_perception(payload.target_object)
        source = "fallback"

    if rate_limited:
        decision = NavigationDecision(
            action=NavigationAction.HOLD,
            confidence=0,
            reason="Vision service is rate limited; hold while the app waits to retry.",
            should_replan=True,
            candidate_scores={NavigationAction.HOLD: 0.0},
        )
    else:
        decision = navigation_engine.decide(perception)
    return navigation_result(
        payload,
        perception,
        decision,
        source=source,
        started=started,
        gemini_ms=gemini_ms,
        parsing_ms=parsing_ms,
        error=perception_error,
        model=model_used,
        rate_limited=rate_limited,
        retry_after_ms=retry_after_ms,
    )


@app.post("/api/traversability-frame")
def analyze_traversability_frame(payload: FrameRequest) -> dict[str, Any]:
    """Return the local Phase 1 mask independently from cloud navigation."""
    return traversability_result(decode_image(payload.image_base64))


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
