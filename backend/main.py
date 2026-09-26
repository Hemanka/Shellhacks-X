import base64
import json
import os
import uuid
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="Wayfinder Gemini API", version="0.1.0")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent"


class FrameRequest(BaseModel):
    image_base64: str = Field(min_length=1)
    target_object: str = Field(default="object", min_length=1, max_length=100)
    heading_deg: float = Field(default=0, ge=-360, le=360)


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


@app.get("/api/health")
def health() -> dict[str, str | bool]:
    configured = bool(gemini_key())
    return {"status": "ok", "gemini_configured": configured, "demo_mode": os.getenv("DEMO_MODE", "false").lower() == "true"}


@app.post("/api/analyze-frame")
def analyze_frame(payload: FrameRequest) -> dict[str, Any]:
    api_key = gemini_key()
    if os.getenv("DEMO_MODE", "false").lower() == "true" or not api_key:
        return demo_result(payload.target_object, payload.heading_deg)

    image_bytes = decode_image(payload.image_base64)
    body = {
        "contents": [{"parts": [
            {"text": (
                "Analyze this entire camera frame for navigation. Detect every distinct visible physical "
                "object in the scene, including furniture, electronics, people, wall-mounted items, and "
                f"the requested target {payload.target_object!r} if it is visible. The target is not a filter: "
                "always return all visible objects. "
                "Return only valid JSON matching this schema: "
                '{"objects":[{"label":"string","confidence":0.0,"bbox":[x,y,width,height]}]}. '
                "Use normalized coordinates from 0 to 1. Return one tight bounding box per distinct object, "
                "including partially visible objects when enough of the object is identifiable. "
                "Do not invent objects or return an empty list when visible objects are present."
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
            GEMINI_URL,
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
