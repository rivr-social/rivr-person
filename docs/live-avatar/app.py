"""Live-avatar worker -- FastAPI service.

Animates a single reference portrait into a live MJPEG "talking picture"
stream, mouth driven by speech audio (or a text-timing fallback). Pairs
with rivr-person's /api/autobot/live-avatar/* routes.

API:
  GET    /health
  POST   /sessions                       {reference_image_url} | multipart "file" -> {sessionId}
  GET    /sessions/{id}                  status
  DELETE /sessions/{id}
  POST   /sessions/{id}/speak            multipart "file" (audio) OR JSON {text, durationMs}
  POST   /sessions/{id}/stop-speaking    barge-in: cut the current utterance
  GET    /sessions/{id}/stream           multipart/x-mixed-replace MJPEG

Environment variables:
  PORT                 -- listen port (default 8012)
  API_KEY              -- optional Bearer token (also accepted as ?key= on /stream)
  AVATAR_FPS           -- animation framerate (default 12; speech runs
                          10-15 phones/s, so lower rates undersample the
                          mouth and read as "flappy")
  MAX_SESSIONS         -- concurrent session cap (default 8)
  SESSION_IDLE_TIMEOUT -- seconds before an untouched session is reaped (default 900)
  FETCH_TIMEOUT_S      -- reference-image download timeout (default 20)
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import random
import time
import uuid
from dataclasses import dataclass, field

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from audio_env import (
    AudioDecodeError,
    envelope_from_audio,
    envelope_from_text,
)
from engine import (
    FaceLayout,
    JPEG_QUALITY,
    PortraitRig,
    build_rig,
    render_frame,
    resize_portrait,
)
from engine_frames import (
    FramePack,
    VISEME_REST,
    build_frame_pack,
    render_pack_frame,
)
from phonemes import viseme_timeline

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("PORT", "8012"))
API_KEY = os.environ.get("API_KEY", "")
AVATAR_FPS = float(os.environ.get("AVATAR_FPS", "12"))
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "8"))
SESSION_IDLE_TIMEOUT_S = float(os.environ.get("SESSION_IDLE_TIMEOUT", "900"))
FETCH_TIMEOUT_S = float(os.environ.get("FETCH_TIMEOUT_S", "20"))
MAX_IMAGE_BYTES = 12 * 1024 * 1024
REAPER_INTERVAL_S = 60.0

# Blink behaviour: Poisson-ish blinks every BLINK_MIN..BLINK_MAX seconds.
BLINK_MIN_INTERVAL_S = 2.5
BLINK_MAX_INTERVAL_S = 6.0
BLINK_DURATION_S = 0.18

MJPEG_BOUNDARY = "frame"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("live-avatar")

app = FastAPI(
    title="Live Avatar Worker",
    version="1.0.0",
    description="Realtime talking-picture MJPEG streams from a single portrait.",
)


# ---------------------------------------------------------------------------
# Session model
# ---------------------------------------------------------------------------


@dataclass
class Utterance:
    envelope: list[float]
    started_at: float  # time.monotonic()
    visemes: list[str] | None = None
    #: GPU-rendered speaking frames (already session-sized JPEGs). When
    #: present they REPLACE viseme/warp mouth animation for this utterance.
    clip_frames: list[bytes] | None = None
    clip_fps: float = 25.0

    def frame_index(self, now: float, fps: float) -> int | None:
        index = int((now - self.started_at) * fps)
        if index < 0:
            return 0
        if index >= len(self.envelope):
            return None
        return index

    def amplitude_at(self, now: float, fps: float) -> float | None:
        """Amplitude for the current frame, or None once finished."""
        index = self.frame_index(now, fps)
        return None if index is None else self.envelope[index]

    def viseme_at(self, now: float, fps: float) -> str | None:
        """Viseme label for the current frame, or None once finished."""
        index = self.frame_index(now, fps)
        if index is None:
            return None
        if not self.visemes or index >= len(self.visemes):
            return VISEME_REST
        return self.visemes[index]

    def clip_frame_at(self, now: float) -> bytes | None:
        """GPU clip frame for the elapsed time, or None once finished."""
        if not self.clip_frames:
            return None
        index = int((now - self.started_at) * self.clip_fps)
        if index < 0:
            index = 0
        if index >= len(self.clip_frames):
            return None
        return self.clip_frames[index]


@dataclass
class AvatarSession:
    session_id: str
    rig: PortraitRig
    """Viseme frame pack; when present the session animates by frame swap."""
    pack: FramePack | None = None
    """GPU sidecar base URL for per-utterance Wav2Lip renders ("" = off)."""
    gpu_animate_url: str = ""
    """Session portrait as JPEG — the face the GPU sidecar animates."""
    portrait_jpeg: bytes | None = None
    created_at: float = field(default_factory=time.monotonic)
    last_access: float = field(default_factory=time.monotonic)
    utterance: Utterance | None = None
    latest_frame: bytes | None = None
    frame_event: asyncio.Event = field(default_factory=asyncio.Event)
    animator: asyncio.Task | None = None
    next_blink_at: float = 0.0
    blink_started_at: float | None = None
    brow_level: float = 0.0
    viewers: int = 0

    def touch(self) -> None:
        self.last_access = time.monotonic()


_sessions: dict[str, AvatarSession] = {}
_sessions_lock = asyncio.Lock()


def _validate_api_key(request: Request, allow_query: bool = False) -> None:
    if not API_KEY:
        return
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer ") and auth_header[len("Bearer "):] == API_KEY:
        return
    if allow_query and request.query_params.get("key") == API_KEY:
        return
    raise HTTPException(status_code=401, detail="Missing or invalid API key.")


def _get_session(session_id: str) -> AvatarSession:
    session = _sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Unknown session.")
    session.touch()
    return session


# ---------------------------------------------------------------------------
# Animator loop -- one task per session, shared by all stream viewers
# ---------------------------------------------------------------------------


def _blink_amplitude(session: AvatarSession, now: float) -> float:
    if session.blink_started_at is None:
        if now >= session.next_blink_at:
            session.blink_started_at = now
        else:
            return 0.0

    progress = (now - session.blink_started_at) / BLINK_DURATION_S
    if progress >= 1.0:
        session.blink_started_at = None
        session.next_blink_at = now + random.uniform(
            BLINK_MIN_INTERVAL_S, BLINK_MAX_INTERVAL_S
        )
        return 0.0
    # Triangle profile: close then open.
    return 1.0 - abs(2.0 * progress - 1.0)


async def _animate(session: AvatarSession) -> None:
    frame_interval = 1.0 / AVATAR_FPS
    loop = asyncio.get_running_loop()
    session.next_blink_at = time.monotonic() + random.uniform(
        BLINK_MIN_INTERVAL_S, BLINK_MAX_INTERVAL_S
    )

    try:
        while True:
            started = time.monotonic()

            mouth_amp = 0.0
            viseme = VISEME_REST
            clip_frame: bytes | None = None
            if session.utterance is not None:
                clip_frame = session.utterance.clip_frame_at(started)
                amplitude = session.utterance.amplitude_at(started, AVATAR_FPS)
                if amplitude is None and clip_frame is None:
                    session.utterance = None
                else:
                    mouth_amp = amplitude or 0.0
                    viseme = (
                        session.utterance.viseme_at(started, AVATAR_FPS)
                        or VISEME_REST
                    )

            # GPU-rendered utterance: relay the Wav2Lip frame directly.
            if clip_frame is not None:
                session.latest_frame = clip_frame
                session.frame_event.set()
                session.frame_event = asyncio.Event()
                elapsed = time.monotonic() - started
                await asyncio.sleep(max(0.0, 1.0 / AVATAR_FPS - elapsed))
                continue

            blink_amp = _blink_amplitude(session, started)

            if session.pack is not None:
                # Brow emphasis rides loud stretches (fast attack, slow decay).
                target = 1.0 if mouth_amp > 0.85 else 0.0
                rate = 0.5 if target > session.brow_level else 0.12
                session.brow_level += (target - session.brow_level) * rate
                frame = await loop.run_in_executor(
                    None,
                    render_pack_frame,
                    session.pack,
                    viseme,
                    started - session.created_at,
                    blink_amp,
                    session.brow_level,
                )
                session.latest_frame = frame
                session.frame_event.set()
                session.frame_event = asyncio.Event()
                elapsed = time.monotonic() - started
                await asyncio.sleep(max(0.0, 1.0 / AVATAR_FPS - elapsed))
                continue

            frame = await loop.run_in_executor(
                None,
                render_frame,
                session.rig,
                mouth_amp,
                blink_amp,
                started - session.created_at,
            )
            session.latest_frame = frame
            session.frame_event.set()
            session.frame_event = asyncio.Event()

            elapsed = time.monotonic() - started
            await asyncio.sleep(max(0.0, frame_interval - elapsed))
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Animator crashed for session %s", session.session_id)


GPU_ANIMATE_WAIT_S = 30.0
GPU_ANIMATE_POLL_S = 1.0


def _fit_clip_frames(frames_b64: list, size: tuple[int, int]) -> list[bytes]:
    """Decode sidecar frames and re-encode at the session's geometry."""
    width, height = size
    fitted: list[bytes] = []
    for encoded in frames_b64:
        try:
            data = base64.b64decode(encoded)
        except Exception:
            continue
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            continue
        resized = cv2.resize(image, (width, height), interpolation=cv2.INTER_LINEAR)
        ok, jpeg = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if ok:
            fitted.append(jpeg.tobytes())
    return fitted


async def _try_gpu_clip(
    session: AvatarSession, audio_bytes: bytes, content_type: str,
) -> tuple[list[bytes], float] | None:
    """Ask the GPU sidecar to render the portrait actually speaking this
    audio (Wav2Lip). Bounded wait; None on ANY failure — callers fall back
    to the baked-pack timeline, so this lane can never break speech."""
    if not session.gpu_animate_url or not session.portrait_jpeg:
        return None
    payload = {
        "audio_b64": base64.b64encode(audio_bytes).decode(),
        "audio_mime": content_type or "audio/mpeg",
        "image_b64": base64.b64encode(session.portrait_jpeg).decode(),
    }
    deadline = time.monotonic() + GPU_ANIMATE_WAIT_S
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            start = await client.post(
                f"{session.gpu_animate_url}/animate", json=payload,
            )
            if start.status_code != 200:
                logger.info("gpu animate declined (%s)", start.status_code)
                return None
            job_id = (start.json() or {}).get("jobId")
            if not job_id:
                return None
            while time.monotonic() < deadline:
                await asyncio.sleep(GPU_ANIMATE_POLL_S)
                poll = await client.get(
                    f"{session.gpu_animate_url}/animate/{job_id}",
                )
                if poll.status_code != 200:
                    continue
                job = poll.json() or {}
                if job.get("status") == "error":
                    logger.info(
                        "gpu animate failed: %s", str(job.get("detail"))[:200],
                    )
                    return None
                if job.get("status") == "done":
                    loop = asyncio.get_running_loop()
                    frames = await loop.run_in_executor(
                        None,
                        _fit_clip_frames,
                        job.get("frames") or [],
                        session.rig.size,
                    )
                    fps = float(job.get("fps") or 25.0)
                    return (frames, fps) if frames else None
    except Exception as exc:  # noqa: BLE001 — degrade, never break speech
        logger.info("gpu animate unavailable: %s", exc)
    logger.info("gpu animate timed out after %.0fs", GPU_ANIMATE_WAIT_S)
    return None


async def _destroy_session(session_id: str) -> None:
    async with _sessions_lock:
        session = _sessions.pop(session_id, None)
    if session is None:
        return
    if session.animator is not None:
        session.animator.cancel()
        try:
            await session.animator
        except (asyncio.CancelledError, Exception):
            pass
    logger.info("Session %s destroyed", session_id)


async def _reap_idle_sessions() -> None:
    while True:
        await asyncio.sleep(REAPER_INTERVAL_S)
        now = time.monotonic()
        stale = [
            sid
            for sid, session in _sessions.items()
            if session.viewers == 0 and now - session.last_access > SESSION_IDLE_TIMEOUT_S
        ]
        for sid in stale:
            logger.info("Reaping idle session %s", sid)
            await _destroy_session(sid)


@app.on_event("startup")
async def _startup() -> None:
    asyncio.create_task(_reap_idle_sessions())


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health_check() -> dict[str, object]:
    return {
        "status": "ok",
        "service": "live-avatar",
        "sessions": len(_sessions),
        "fps": AVATAR_FPS,
    }


async def _fetch_url_bytes(url: str, cap: int = MAX_IMAGE_BYTES) -> bytes:
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        if not response.content or len(response.content) > cap:
            raise HTTPException(status_code=422, detail=f"Fetch empty/too large: {url}")
        return response.content


def _layout_from_calibration(
    calibration: dict, width: int, height: int
) -> FaceLayout | None:
    """Build a FaceLayout from normalized tap-calibration points."""
    try:
        mouth = calibration["mouth"]
        left_eye = calibration["leftEye"]
        right_eye = calibration["rightEye"]
        mouth_px = (float(mouth[0]) * width, float(mouth[1]) * height)
        left_px = (float(left_eye[0]) * width, float(left_eye[1]) * height)
        right_px = (float(right_eye[0]) * width, float(right_eye[1]) * height)
    except (KeyError, TypeError, IndexError, ValueError):
        return None

    eye_span = max(8.0, abs(right_px[0] - left_px[0]))
    eye_center_y = (left_px[1] + right_px[1]) / 2.0
    face_height = max(24.0, (mouth_px[1] - eye_center_y) * 2.4)
    return FaceLayout(
        mouth_center=mouth_px,
        mouth_width=eye_span * 0.75,
        left_eye=left_px,
        right_eye=right_px,
        eye_width=eye_span * 0.22,
        face_height=face_height,
        detected=True,  # human-supplied placement is authoritative
    )


@app.post("/sessions")
async def create_session(
    request: Request,
    file: UploadFile | None = File(default=None),
    options: str | None = Form(default=None),
) -> JSONResponse:
    _validate_api_key(request)

    session_options: dict = {}
    if options:
        try:
            parsed = json.loads(options)
            if isinstance(parsed, dict):
                session_options = parsed
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="options must be JSON")

    image_bytes: bytes | None = None
    if file is not None:
        image_bytes = await file.read()
    else:
        try:
            body = await request.json()
        except Exception:
            body = {}
        reference_url = body.get("reference_image_url") if isinstance(body, dict) else None
        if not reference_url or not isinstance(reference_url, str):
            raise HTTPException(
                status_code=400,
                detail="Provide multipart 'file' or JSON {reference_image_url}.",
            )
        try:
            async with httpx.AsyncClient(
                timeout=FETCH_TIMEOUT_S, follow_redirects=True
            ) as client:
                response = await client.get(reference_url)
                response.raise_for_status()
                image_bytes = response.content
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=422,
                detail=f"Could not fetch reference image: {exc}",
            ) from exc

    if not image_bytes:
        raise HTTPException(status_code=400, detail="Empty image payload.")
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Reference image too large.")

    decoded = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise HTTPException(status_code=422, detail="Could not decode image.")

    # Optional baked viseme pack: label → frame URL. Frame-swap mode when
    # at least a couple of frames resolve.
    pack: FramePack | None = None
    viseme_frames = session_options.get("visemeFrames")
    if isinstance(viseme_frames, dict) and viseme_frames:
        images: dict[str, bytes] = {}
        for label, url in viseme_frames.items():
            if not isinstance(url, str) or not url:
                continue
            try:
                images[str(label)] = await _fetch_url_bytes(url)
            except (httpx.HTTPError, HTTPException) as exc:
                logger.warning("viseme frame %s fetch failed: %s", label, exc)
        if len(images) >= 2:
            try:
                pack = build_frame_pack(images)
            except ValueError as exc:
                logger.warning("viseme pack rejected: %s", exc)

    # Optional manual calibration (used by the warp engine only).
    layout: FaceLayout | None = None
    calibration = session_options.get("calibration")
    if isinstance(calibration, dict):
        resized = resize_portrait(decoded)
        height_r, width_r = resized.shape[:2]
        layout = _layout_from_calibration(calibration, width_r, height_r)

    # Optional GPU sidecar for per-utterance Wav2Lip renders. The portrait
    # is kept as JPEG — it is the face the sidecar animates per reply.
    gpu_animate_url = ""
    raw_animate = session_options.get("gpuAnimateUrl")
    if isinstance(raw_animate, str) and raw_animate.startswith("http"):
        gpu_animate_url = raw_animate.rstrip("/")

    async with _sessions_lock:
        if len(_sessions) >= MAX_SESSIONS:
            raise HTTPException(status_code=429, detail="Session limit reached.")
        session_id = uuid.uuid4().hex[:16]
        loop = asyncio.get_running_loop()
        rig = await loop.run_in_executor(None, build_rig, decoded, layout)
        portrait_jpeg: bytes | None = None
        if gpu_animate_url:
            ok_jpeg, encoded = cv2.imencode(
                ".jpg", rig.base, [cv2.IMWRITE_JPEG_QUALITY, 92],
            )
            portrait_jpeg = encoded.tobytes() if ok_jpeg else None
        session = AvatarSession(
            session_id=session_id,
            rig=rig,
            pack=pack,
            gpu_animate_url=gpu_animate_url,
            portrait_jpeg=portrait_jpeg,
        )
        session.animator = asyncio.create_task(_animate(session))
        _sessions[session_id] = session

    width, height = rig.size
    mode = "frames" if pack is not None else "warp"
    logger.info(
        "Session %s created (%dx%d, mode=%s, face_detected=%s, pack=%s)",
        session_id, width, height, mode, rig.layout.detected,
        len(pack.frames) if pack else 0,
    )
    return JSONResponse(
        {
            "sessionId": session_id,
            "width": width,
            "height": height,
            "faceDetected": rig.layout.detected,
            "mode": mode,
            "fps": AVATAR_FPS,
        }
    )


@app.get("/sessions/{session_id}")
async def session_status(session_id: str, request: Request) -> dict[str, object]:
    _validate_api_key(request)
    session = _get_session(session_id)
    width, height = session.rig.size
    return {
        "sessionId": session.session_id,
        "speaking": session.utterance is not None,
        "viewers": session.viewers,
        "width": width,
        "height": height,
        "faceDetected": session.rig.layout.detected,
    }


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str, request: Request) -> dict[str, bool]:
    _validate_api_key(request)
    _get_session(session_id)
    await _destroy_session(session_id)
    return {"ok": True}


@app.post("/sessions/{session_id}/speak")
async def speak(
    session_id: str,
    request: Request,
    file: UploadFile | None = File(default=None),
    text: str | None = Form(default=None),
) -> dict[str, object]:
    _validate_api_key(request)
    session = _get_session(session_id)

    envelope: list[float]
    source: str
    speech_text = (text or "").strip()
    if file is not None:
        audio_bytes = await file.read()
        loop = asyncio.get_running_loop()
        try:
            envelope = await loop.run_in_executor(
                None, envelope_from_audio, audio_bytes, AVATAR_FPS
            )
        except AudioDecodeError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        source = "audio"
    else:
        try:
            body = await request.json()
        except Exception:
            body = {}
        body_text = body.get("text") if isinstance(body, dict) else None
        if not body_text or not isinstance(body_text, str):
            raise HTTPException(
                status_code=400,
                detail="Provide multipart audio 'file' or JSON {text, durationMs?}.",
            )
        speech_text = body_text.strip()
        duration_ms = body.get("durationMs")
        envelope = envelope_from_text(
            speech_text,
            AVATAR_FPS,
            duration_ms if isinstance(duration_ms, (int, float)) and duration_ms > 0 else None,
        )
        source = "text"

    if not envelope:
        raise HTTPException(status_code=422, detail="Empty speech envelope.")

    # Frame-swap sessions get a per-frame viseme timeline: phoneme sequence
    # from the text stretched over the envelope, closed during silences.
    visemes: list[str] | None = None
    if session.pack is not None and speech_text:
        loop = asyncio.get_running_loop()
        visemes = await loop.run_in_executor(
            None, viseme_timeline, speech_text, len(envelope), envelope
        )

    # GPU-live enhancement: with real audio and a sidecar attached, render
    # the portrait actually speaking (bounded wait, pack fallback).
    clip_frames: list[bytes] | None = None
    clip_fps = 25.0
    if source == "audio" and session.gpu_animate_url:
        clip = await _try_gpu_clip(
            session, audio_bytes, (file and file.content_type) or "audio/mpeg",
        )
        if clip:
            clip_frames, clip_fps = clip
            source = "gpu"

    session.utterance = Utterance(
        envelope=envelope,
        started_at=time.monotonic(),
        visemes=visemes,
        clip_frames=clip_frames,
        clip_fps=clip_fps,
    )
    duration_ms = int(len(envelope) / AVATAR_FPS * 1000)
    logger.info(
        "Session %s speaking: %s frames (%d ms, source=%s)",
        session_id, len(envelope), duration_ms, source,
    )
    return {"ok": True, "durationMs": duration_ms, "frames": len(envelope), "source": source}


@app.post("/sessions/{session_id}/stop-speaking")
async def stop_speaking(session_id: str, request: Request) -> dict[str, bool]:
    _validate_api_key(request)
    session = _get_session(session_id)
    session.utterance = None
    return {"ok": True}


@app.get("/sessions/{session_id}/stream")
async def stream(session_id: str, request: Request) -> StreamingResponse:
    _validate_api_key(request, allow_query=True)
    session = _get_session(session_id)

    async def frame_generator():
        session.viewers += 1
        try:
            while session.session_id in _sessions:
                event = session.frame_event
                frame = session.latest_frame
                if frame is not None:
                    yield (
                        b"--" + MJPEG_BOUNDARY.encode() + b"\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n"
                        + frame + b"\r\n"
                    )
                session.touch()
                try:
                    await asyncio.wait_for(event.wait(), timeout=5.0)
                except asyncio.TimeoutError:
                    continue
        finally:
            session.viewers = max(0, session.viewers - 1)

    return StreamingResponse(
        frame_generator(),
        media_type=f"multipart/x-mixed-replace; boundary={MJPEG_BOUNDARY}",
        headers={"Cache-Control": "no-store"},
    )
