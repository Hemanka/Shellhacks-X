"""Ephemeral, bidirectional pairing between the dashboard and phone."""
import asyncio
import base64
import os
import socket
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from time import monotonic
from urllib.parse import urlsplit

import qrcode
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ValidationError
from .telemetry import FrameMeta, Orientation, CueMeta

router = APIRouter()


@dataclass
class PairingSession:
    peers: dict = field(default_factory=lambda: {"pc": None, "mobile": None})
    locks: dict = field(default_factory=lambda: {"pc": asyncio.Lock(), "mobile": asyncio.Lock()})
    created: float = field(default_factory=monotonic)


sessions: dict[str, PairingSession] = {}


class PairingRequest(BaseModel):
    public_url: str | None = None


def pairing_origin(request: Request, public_url: str | None) -> str:
    configured = public_url or os.getenv("PAIR_BASE_URL")
    if configured:
        parsed = urlsplit(configured.strip())
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise HTTPException(422, "Use an HTTPS address such as https://your-tunnel.example")
        return f"https://{parsed.netloc}"
    if os.getenv("PAIR_HOST"):
        scheme = os.getenv("PAIR_SCHEME", "https")
        port = os.getenv("PAIR_PORT", "443" if scheme == "https" else "8000")
        suffix = "" if (scheme, port) in (("https", "443"), ("http", "80")) else f":{port}"
        return f"{scheme}://{os.environ['PAIR_HOST']}{suffix}"
    if request.url.scheme == "https":
        return str(request.base_url).rstrip("/")
    host = socket.gethostbyname(socket.gethostname())
    return f"http://{host}:{request.url.port or 8000}"


@router.post("/api/pairing")
async def create_pairing(request: Request, payload: PairingRequest | None = None):
    origin = pairing_origin(request, payload.public_url if payload else None)
    for key, old in list(sessions.items()):
        if not any(old.peers.values()) and monotonic() - old.created > 7200:
            del sessions[key]
    session_id = uuid.uuid4().hex
    sessions[session_id] = PairingSession()
    mobile_url = f"{origin}/mobile.html?session={session_id}"
    output = BytesIO()
    qrcode.make(mobile_url).save(output, format="PNG")
    return {
        "session_id": session_id, "mobile_url": mobile_url,
        "secure": origin.startswith("https://"),
        "qr_data_url": "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii"),
    }


def relay_message(role: str, message: object) -> dict | None:
    """Relay a bounded set of phone inputs and dashboard outputs only."""
    if not isinstance(message, dict):
        return None
    kind = message.get("type")
    if role == "mobile":
        if kind == "frame":
            image = message.get("image_base64")
            if isinstance(image, str) and image.startswith("data:image/jpeg;base64,") and len(image) <= 4_000_000:
                result = {"type": kind, "image_base64": image}
                if "meta" in message:
                    try:
                        result["meta"] = FrameMeta.model_validate(message["meta"]).model_dump()
                    except ValidationError:
                        return None
                return result
        if kind == "orientation":
            try:
                orientation = Orientation.model_validate(message.get("orientation"))
                stream = message.get("stream")
                if not isinstance(stream, str) or not 0 < len(stream) <= 100:
                    return None
                return {"type": kind, "stream": stream, "orientation": orientation.model_dump()}
            except ValidationError:
                return None
        if kind == "transcript":
            text = message.get("text")
            if isinstance(text, str) and 0 < len(text.strip()) <= 500:
                return {"type": kind, "text": text.strip()}
        if kind == "control" and message.get("action") in ("pause", "resume"):
            return {"type": kind, "action": message["action"]}
        if kind == "listening" and isinstance(message.get("active"), bool):
            return {"type": kind, "active": message["active"]}
        if kind == "phone_status":
            allowed = ("camera", "microphone", "speech", "detail", "orientation", "haptics")
            result = {"type": kind}
            for key in allowed:
                value = message.get(key)
                if isinstance(value, str):
                    result[key] = value[:300]
            return result
    elif role == "pc":
        if kind in ("guidance", "hazard"):
            text = message.get("text")
            if isinstance(text, str) and 0 < len(text.strip()) <= 500:
                result = {"type": kind, "text": text.strip()}
                if "id" in message or kind == "hazard":
                    try:
                        result.update(CueMeta.model_validate(message).model_dump())
                    except ValidationError:
                        return None
                return result
        if kind in ("stop_speech", "cancel_hazard"):
            return {"type": kind}
        if kind == "session_state" and isinstance(message.get("running"), bool):
            result = {"type": kind, "running": message["running"], "target": str(message.get("target", ""))[:100]}
            revision = message.get("revision")
            if isinstance(revision, int) and not isinstance(revision, bool) and revision >= 0:
                result["revision"] = revision
            return result
    return None


async def send(session: PairingSession, role: str, message: dict):
    async with session.locks[role]:
        peer = session.peers[role]
        if peer:
            try:
                await asyncio.wait_for(peer.send_json(message), timeout=3)
            except (WebSocketDisconnect, RuntimeError, OSError, asyncio.TimeoutError):
                if session.peers[role] is peer:
                    session.peers[role] = None
                try:
                    await peer.close()
                except (RuntimeError, OSError):
                    pass


@router.websocket("/ws/pair/{session_id}")
async def pairing_socket(websocket: WebSocket, session_id: str, role: str = "mobile"):
    session = sessions.get(session_id)
    if session is None or role not in ("pc", "mobile"):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    previous = session.peers[role]
    session.peers[role] = websocket
    if previous:
        await previous.close(code=1000)
    other = "pc" if role == "mobile" else "mobile"
    await send(session, role, {"type": "peer_status", "role": other, "connected": session.peers[other] is not None})
    await send(session, other, {"type": "peer_status", "role": role, "connected": True})
    try:
        while True:
            message = await websocket.receive_json()
            payload = relay_message(role, message)
            if payload:
                await send(session, other, payload)
    except (WebSocketDisconnect, RuntimeError, ValueError):
        pass
    finally:
        if session.peers[role] is websocket:
            session.peers[role] = None
            await send(session, other, {"type": "peer_status", "role": role, "connected": False})
