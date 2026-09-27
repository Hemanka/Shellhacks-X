import base64
import json
import os
import re
import uuid
from collections import OrderedDict
from io import BytesIO
from pathlib import Path
from threading import Lock, Thread
from time import perf_counter, time
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageStat, UnidentifiedImageError
from pydantic import BaseModel, Field

from .pairing import router as pairing_router
from .telemetry import FrameMeta
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
from .traversability.route import plan_routes
from .traversability.debug import overlay_data_url
from .traversability.segmenter import SegformerTraversabilitySegmenter, TraversabilityMask

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / ".env.local")

app = FastAPI(title="Wayfinder Gemini API", version="0.1.0")
app.include_router(pairing_router)
GEMINI_URL_TEMPLATE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_GEMINI_MODELS = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite")
# The local desktop sandbox may inject an unusable proxy for outbound API calls.
# Gemini traffic should use the machine's direct HTTPS connection.
gemini_session = requests.Session()
gemini_session.trust_env = False
elevenlabs_session = requests.Session()
elevenlabs_session.trust_env = False
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"
DEFAULT_ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"
MAX_VOICE_COMMAND_BYTES = 10 * 1024 * 1024
traversability_segmenter = SegformerTraversabilitySegmenter()
traversability_masks: OrderedDict[tuple[str, int], tuple[float, TraversabilityMask]] = OrderedDict()
traversability_masks_lock = Lock()
mask_warmup_status: dict[str, Any] = {"state": "warming", "durationMs": None, "error": None}
mask_warmup_lock = Lock()
mask_warmup_thread: Thread | None = None
# Per-model quota cooldown; navigation state remains session-local.
gemini_model_cooldowns: dict[str, float] = {}


def _warm_mask_model() -> None:
    started = perf_counter()
    try:
        traversability_segmenter.warmup()
    except Exception as exc:
        with mask_warmup_lock:
            mask_warmup_status.update(state="unavailable", durationMs=round((perf_counter() - started) * 1000, 1), error=type(exc).__name__)
        print(f"Traversability model warm-up failed: {type(exc).__name__}: {exc}")
        return
    with mask_warmup_lock:
        mask_warmup_status.update(state="ready", durationMs=round((perf_counter() - started) * 1000, 1), error=None)
    print(f"Traversability model warmed in {mask_warmup_status['durationMs']:.1f} ms.")


def start_mask_warmup() -> None:
    """Warm the local segmentation model without delaying API startup."""
    global mask_warmup_thread
    with mask_warmup_lock:
        if mask_warmup_thread is not None and mask_warmup_thread.is_alive():
            return
        mask_warmup_status.update(state="warming", durationMs=None, error=None)
        mask_warmup_thread = Thread(target=_warm_mask_model, name="mask-model-warmup", daemon=True)
        mask_warmup_thread.start()


app.add_event_handler("startup", start_mask_warmup)

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
    frame_meta: FrameMeta | None = None
    perception: dict[str, Any] | None = None


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=500)


class TraversabilityRouteRequest(BaseModel):
    frame_meta: FrameMeta
    perception: dict[str, Any]


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
    attempts: list[dict] | None = None,
) -> dict[str, Any]:
    target = perception.target
    guidance = guidance_for_step(decision, perception)
    box = perception.details.get("target", {}).get("bbox")
    candidates = []
    if target and target.visible and box:
        left, top, right, bottom = box
        candidates.append({"label": target.label, "score": target.confidence, "bbox": [left, top, right-left, bottom-top]})
    result = {
        "frame_id": str(uuid.uuid4())[:8],
        "frame_meta": payload.frame_meta.model_dump() if payload.frame_meta else None,
        "heading_deg": payload.heading_deg,
        "candidates": candidates,
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
        "geminiAttempts": attempts or [],
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


def mask_signature(mask: TraversabilityMask) -> list[list[float]]:
    signature = []
    for row in range(12):
        signature_row = []
        y1, y2 = round(row * mask.height / 12), round((row + 1) * mask.height / 12)
        for col in range(16):
            x1, x2 = round(col * mask.width / 16), round((col + 1) * mask.width / 16)
            signature_row.append(round(float(mask.candidate_walkable_mask[y1:y2, x1:x2].mean()), 2))
        signature.append(signature_row)
    return signature


def traversability_result(image_bytes: bytes, perception: dict[str, Any] | None = None,
                          frame_meta: FrameMeta | None = None) -> dict[str, Any]:
    """Run Phase 1 semantic segmentation and serialize its live debug overlay."""
    started = perf_counter()
    try:
        with Image.open(BytesIO(image_bytes)) as source:
            source.load()
            image = source.convert("RGB")
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Invalid camera image") from exc

    try:
        mask = traversability_segmenter.segment(image)
    except Exception as exc:
        print(f"Traversability segmentation failed: {exc}")
        raise HTTPException(
            status_code=503,
            detail="Local traversability segmentation is unavailable",
        ) from exc

    if frame_meta is not None:
        cache_key = (frame_meta.stream, frame_meta.seq)
        with traversability_masks_lock:
            traversability_masks[cache_key] = (perf_counter(), mask)
            traversability_masks.move_to_end(cache_key)
            while len(traversability_masks) > 8:
                traversability_masks.popitem(last=False)

    scene = perception or {}
    target = scene.get("target") if isinstance(scene.get("target"), dict) else {}
    target_bbox = target.get("bbox") if target.get("visible") else None
    target_direction = target.get("direction", "CENTER")
    if not isinstance(target_bbox, list) or len(target_bbox) != 4:
        target_bbox = None

    stats = {name: round(value, 2) for name, value in mask.percentages().items()}
    signature = mask_signature(mask)
    total_ms = (perf_counter() - started) * 1000
    print(
        f"Traversability: {mask.inference_ms:.1f} ms inference | "
        f"{stats['candidate_walkable']:.1f}% candidate | "
        f"{stats['unknown']:.1f}% unknown | {total_ms:.1f} ms total"
    )
    return {
        "overlayDataUrl": overlay_data_url(mask),
        "pathPlan": plan_routes(mask, target_bbox, target_direction),
        "maskSignature": signature,
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


def elevenlabs_error_message(response: requests.Response | None) -> str:
    if response is None:
        return ""
    try:
        body = response.json()
    except ValueError:
        return ""
    detail = body.get("detail") or body.get("message") or body.get("error") or ""
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("status") or detail.get("code") or ""
    return str(detail)[:500]


def elevenlabs_quota_exhausted(response: requests.Response | None) -> bool:
    return bool(re.search(r"quota|credits? remaining|out of credits", elevenlabs_error_message(response), re.I))


@app.get("/api/health")
def health() -> dict[str, Any]:
    configured = bool(gemini_key())
    with mask_warmup_lock:
        mask_model = dict(mask_warmup_status)
    return {
        "status": "ok",
        "gemini_configured": configured,
        "elevenlabs_configured": bool(elevenlabs_key()),
        "demo_mode": os.getenv("DEMO_MODE", "false").lower() == "true",
        "mask_model": mask_model,
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
        response = elevenlabs_session.post(
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
        if exc.response is not None and elevenlabs_quota_exhausted(exc.response):
            raise HTTPException(status_code=429, detail="ElevenLabs credits are exhausted; using the phone's built-in voice") from exc
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
        response = elevenlabs_session.post(
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
        if exc.response is not None and elevenlabs_quota_exhausted(exc.response):
            raise HTTPException(status_code=429, detail="ElevenLabs credits are exhausted; use browser speech recognition or add credits") from exc
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
    navigation_engine = CameraRelativeNavigator()
    started = perf_counter()

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
    try:
        with Image.open(BytesIO(image_bytes)) as source_image:
            thumbnail = source_image.convert("L").resize((64, 64))
            blank = ImageStat.Stat(thumbnail).stddev[0] < 3
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(status_code=422, detail="Camera frame is not a readable image")
    if blank:
        perception = uncertain_perception(payload.target_object)
        return navigation_result(payload, perception, navigation_engine.decide(perception),
                                 source="insufficient_image", started=started,
                                 error="Camera view has too little visual detail; show the room and target.")
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
    attempts = []
    try:
        configured_models = gemini_models()
        models = tuple(model for model in configured_models if gemini_model_cooldowns.get(model, 0) <= perf_counter())
        if not models:
            retry_after_ms = max(1000, int((min(gemini_model_cooldowns[m] for m in configured_models)-perf_counter())*1000))
            perception = uncertain_perception(payload.target_object)
            return navigation_result(payload, perception, navigation_engine.decide(perception), source="rate_limit",
                                     started=started, rate_limited=True, retry_after_ms=retry_after_ms,
                                     error="Gemini models are cooling down after quota limits")
        response = None
        for index, model in enumerate(models):
            model_used = model
            attempt_started = perf_counter()
            response = gemini_session.post(
                GEMINI_URL_TEMPLATE.format(model=model),
                params={"key": api_key},
                json=body,
                timeout=30,
            )
            attempts.append({"model": model, "status": response.status_code, "durationMs": round((perf_counter()-attempt_started)*1000, 1)})
            if response.status_code == 429:
                gemini_model_cooldowns[model] = perf_counter() + max(30_000, gemini_retry_after_ms(response))/1000
            else:
                gemini_model_cooldowns.pop(model, None)
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
        if isinstance(exc, requests.Timeout):
            perception_error = "Gemini request timed out before Google replied"
        else:
            perception_error = f"Gemini connection failed ({type(exc).__name__})"
        print(f"Gemini transport failure: {type(exc).__name__}")
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
        attempts=attempts,
    )


@app.post("/api/traversability-frame")
def analyze_traversability_frame(payload: FrameRequest) -> dict[str, Any]:
    """Return the local Phase 1 mask independently from cloud navigation."""
    result = traversability_result(decode_image(payload.image_base64), payload.perception, payload.frame_meta)
    with mask_warmup_lock:
        if mask_warmup_status["state"] != "ready":
            mask_warmup_status.update(state="ready", error=None)
    result["frame_meta"] = payload.frame_meta.model_dump() if payload.frame_meta else None
    return result


@app.post("/api/traversability-route")
def plan_traversability_route(payload: TraversabilityRouteRequest) -> dict[str, Any]:
    """Plan against the already-computed mask for this exact camera frame."""
    key = (payload.frame_meta.stream, payload.frame_meta.seq)
    with traversability_masks_lock:
        cached = traversability_masks.get(key)
        if cached and perf_counter() - cached[0] > 30:
            traversability_masks.pop(key, None)
            cached = None
        if cached:
            traversability_masks.move_to_end(key)
    if not cached:
        raise HTTPException(status_code=409, detail="Matching camera mask is not ready")
    mask = cached[1]
    scene = payload.perception
    target = scene.get("target") if isinstance(scene.get("target"), dict) else {}
    target_bbox = target.get("bbox") if target.get("visible") else None
    if not isinstance(target_bbox, list) or len(target_bbox) != 4:
        target_bbox = None
    return {
        "pathPlan": plan_routes(mask, target_bbox, target.get("direction", "CENTER")),
        "maskSignature": mask_signature(mask),
        "width": mask.width,
        "height": mask.height,
        "frame_meta": payload.frame_meta.model_dump(),
    }


app.mount("/", StaticFiles(directory=ROOT / "frontend", html=True), name="frontend")
