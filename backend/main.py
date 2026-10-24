"""ErgoPulse: private LAN relay. Camera frames and memo text stay on the PC."""
import asyncio
import secrets
import socket
import time
from pathlib import Path
from typing import Literal
from urllib.parse import urlparse

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

app = FastAPI(title="ErgoPulse", version="2.1.0")
FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
ROOMS = {}
TTL = 12 * 60 * 60
# In-memory, localhost-only, expiring state. Never relay lock commands through QR/phone rooms.
DESKTOP_GUARD = {}
GUARD_TTL = 3.0
GUARD_EVENTS = {"dismissals": 0}


class DesktopGuardUpdate(BaseModel):
    source: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    active: bool
    # Numeric estimates and flags only; never camera frames or landmarks.
    score: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    playful: bool = True
    pause_on_kittens: bool = False
    face_close: bool = False
    grow: bool = True
    zoom_hint: bool = False


def require_local_pc(request: Request):
    if not request.client or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "This action is available only on this PC via localhost")
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Origin mismatch")


@app.post("/api/posture-guard/update")
async def update_desktop_guard(request: Request, data: DesktopGuardUpdate):
    require_local_pc(request)
    now = time.monotonic()
    for key, entry in list(DESKTOP_GUARD.items()):
        if now - entry["seen"] >= GUARD_TTL:
            DESKTOP_GUARD.pop(key, None)
    if len(DESKTOP_GUARD) >= 32 and data.source not in DESKTOP_GUARD:
        raise HTTPException(429, "Too many guard clients")
    DESKTOP_GUARD[data.source] = {"active": data.active, "score": data.score,
                                  "playful": data.playful,
                                  "pause_on_kittens": data.pause_on_kittens,
                                  "face_close": data.face_close,
                                  "grow": data.grow,
                                  "zoom_hint": data.zoom_hint,
                                  "seen": now}
    return {"ok": True, "dismissals": GUARD_EVENTS["dismissals"]}


@app.post("/api/posture-guard/dismiss")
async def dismiss_desktop_guard(request: Request):
    require_local_pc(request)
    GUARD_EVENTS["dismissals"] += 1
    return {"ok": True, "dismissals": GUARD_EVENTS["dismissals"]}


@app.get("/api/posture-guard/state")
async def desktop_guard_state(request: Request):
    require_local_pc(request)
    now = time.monotonic()
    fresh = [entry for entry in DESKTOP_GUARD.values() if now - entry["seen"] < GUARD_TTL]
    # If several tabs exist, select the most recent valid camera measurement.
    measured = [entry for entry in fresh if entry.get("score") is not None or entry.get("face_close")]
    newest = max(measured, key=lambda entry: entry["seen"]) if measured else None
    result = {"active": any(entry["active"] for entry in fresh),
              "score": newest["score"] if newest else None,
              "playful": newest.get("playful", True) if newest else False,
              "pause_on_kittens": newest.get("pause_on_kittens", False) if newest else False,
              "face_close": newest.get("face_close", False) if newest else False,
              "grow": newest.get("grow", True) if newest else False}
    if newest and newest.get("zoom_hint"):
        result["zoom_hint"] = True
    return result


class RelayMessage(BaseModel):
    type: Literal["state", "intervene", "recovered", "start", "defer", "cancel", "commit", "ping"]
    mode: Literal["standby", "ambient", "buddy", "recovery", "rest"] = "standby"
    event_id: str = Field(default="", max_length=100)
    score: float = Field(default=100, ge=0, le=100)
    progress: float = Field(default=0, ge=0, le=100)
    remaining: int = Field(default=0, ge=0, le=3600)
    reason: str = Field(default="", max_length=160)
    exercise: Literal["banzai", "shoulder"] = "banzai"
    demo: bool = False
    tracking: bool = False


def expired(room):
    return time.monotonic() - room["created"] > TTL


def get_room(room_id):
    room = ROOMS.get(room_id)
    if not room or expired(room):
        raise HTTPException(404, "連携が終了しました。PCで再接続してください。")
    return room


def public_state(room):
    return {"type": "state", **room["state"], "pc_online": bool(room["pc"]), "phones": len(room["phones"])}


async def broadcast(room, message):
    targets = list(room["phones"]) + ([room["pc"]] if room["pc"] else [])
    for ws in targets:
        try:
            await ws.send_json(message)
        except Exception:
            room["phones"].discard(ws)
            if room["pc"] is ws:
                room["pc"] = None


@app.get("/")
async def home():
    return FileResponse(FRONTEND / "index.html", headers={"Referrer-Policy": "no-referrer"})


@app.post("/api/session")
async def create_session(request: Request):
    # Reject browser requests initiated from a different origin.
    origin = request.headers.get("origin")
    if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
        raise HTTPException(403, "Origin mismatch")
    for key, room in list(ROOMS.items()):
        if time.monotonic() - room["created"] > TTL:
            ROOMS.pop(key, None)
    if len(ROOMS) >= 100:
        raise HTTPException(429, "セッション上限です。サーバーを再起動してください。")
    room_id, controller = secrets.token_urlsafe(18), secrets.token_urlsafe(24)
    ROOMS[room_id] = {"created": time.monotonic(), "controller": controller, "pc": None, "phones": set(),
                      "last_event": None, "state": {"mode": "standby", "score": 100, "progress": 0}}
    host = request.url.hostname
    candidates = []
    if host in ("localhost", "127.0.0.1", "::1"):
        try:
            candidates = [ip for ip in socket.gethostbyname_ex(socket.gethostname())[2]
                          if not ip.startswith("127.") and ":" not in ip]
        except OSError:
            pass
    else:
        candidates = [host]
    def lan_rank(ip):  # Wi-Fi/LAN addresses first; VPN/virtual adapters (e.g. 169.254, 172.x) later
        return 0 if ip.startswith("192.168.") else 1 if ip.startswith("10.") else 2 if ip.startswith("172.") else 3
    candidates = sorted(dict.fromkeys(candidates), key=lambda ip: (lan_rank(ip) if host in ("localhost", "127.0.0.1", "::1") else 0))
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    return {"room": room_id, "controller_key": controller,
            "join_urls": [f"{request.url.scheme}://{ip}:{port}/?phone={room_id}" for ip in dict.fromkeys(candidates)],
            "expires_hours": 12}


@app.post("/api/git-commit-hook/{room_id}")
async def commit_hook(room_id: str, x_controller_key: str = Header(default="")):
    room = get_room(room_id)
    if not secrets.compare_digest(x_controller_key, room["controller"]):
        raise HTTPException(403, "Invalid controller key")
    if not room["pc"]:
        raise HTTPException(409, "PC画面を接続してください。")
    now = time.monotonic()
    if now - room.get("last_hook", -10) < 1:  # a commit hook never needs more than ~1 call/s
        raise HTTPException(429, "Too many requests")
    room["last_hook"] = now
    await room["pc"].send_json({"type": "command", "action": "commit"})
    return {"status": "sent"}


@app.websocket("/ws/{room_id}")
async def relay(ws: WebSocket, room_id: str, role: str = "phone", key: str = ""):
    try:
        room = get_room(room_id)
    except HTTPException:
        await ws.close(code=1008)
        return
    if role not in ("pc", "phone") or (role == "pc" and not secrets.compare_digest(key, room["controller"])):
        await ws.close(code=1008)
        return
    origin = ws.headers.get("origin")
    if origin:
        if urlparse(origin).netloc != ws.headers.get("host"):
            await ws.close(code=1008)
            return
    if role == "phone" and len(room["phones"]) >= 8:
        await ws.close(code=1008)
        return
    if role == "pc" and room["pc"]:
        await ws.close(code=1008)
        return
    await ws.accept()
    if role == "pc":
        room["pc"] = ws
    else:
        room["phones"].add(ws)
    await broadcast(room, public_state(room))
    if role == "phone" and room["last_event"] and room["state"].get("mode") in ("buddy", "recovery"):
        await ws.send_json(room["last_event"])
    try:
        while True:
            raw = await ws.receive_text()
            if expired(room):  # enforce the 12h limit on already-open sockets too
                await ws.close(code=1008)
                break
            if len(raw) > 4096:
                await ws.close(code=1009)
                break
            try:
                if hasattr(RelayMessage, "model_validate_json"):
                    msg = RelayMessage.model_validate_json(raw)
                else:
                    msg = RelayMessage.parse_raw(raw)
            except ValidationError:
                await ws.send_json({"type": "error", "message": "Invalid message"})
                continue
            if msg.type == "ping":
                await ws.send_json({"type": "pong"})
                continue
            if role == "phone":
                if msg.type in ("start", "defer", "cancel") and room["pc"]:
                    await room["pc"].send_json({"type": "command", "action": msg.type, "exercise": msg.exercise})
                continue
            if msg.type not in ("state", "intervene", "recovered"):
                continue
            data = msg.model_dump() if hasattr(msg, "model_dump") else msg.dict()
            room["state"] = {k: v for k, v in data.items() if k != "type"}
            if msg.type in ("intervene", "recovered"):
                room["last_event"] = data
            if msg.mode in ("standby", "ambient", "rest"):
                room["last_event"] = None
            await broadcast(room, {**data, "pc_online": True, "phones": len(room["phones"])})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        room["phones"].discard(ws)
        if room["pc"] is ws:
            room["pc"] = None
        await broadcast(room, public_state(room))


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

app.mount("/", StaticFiles(directory=FRONTEND, html=True), name="frontend")
