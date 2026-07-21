/**
 * Chatterbox GPU worker — python source, served to the Vast instance at
 * boot via GET /api/autobot/gpu/worker-source (the onstart script curls it
 * and runs it; no registry, no scp — RIVR ships no images through hubs).
 *
 * Endpoints on the box:
 *   GET  /health                        — liveness + model/voice state
 *   POST /tts {text, voice_url, response_format?}   — zero-shot clone TTS
 *   POST /viseme-pack {image_url}       — one-time bake: LivePortrait runs a
 *        talking driving clip on the portrait, frames are classified into
 *        mouth-shape bins by FaceMesh, best frame per bin returns as PNG.
 *
 * Auth: Bearer CHATTERBOX_AUTH_TOKEN on everything but /health.
 * Modernized from docs/archive/repos/Autobot/chatterbox/server.py.
 */

/**
 * The GPU box runs the MAINTAINED Chatterbox TTS server (devnen), which
 * serves on 8004. This is the port the app resolves + probes.
 */
export const CHATTERBOX_WORKER_PORT = 8004;

export const CHATTERBOX_WORKER_SOURCE = String.raw`#!/usr/bin/env python3
"""RIVR Chatterbox worker: voice-clone TTS + one-time viseme-pack bake."""
import base64
import hashlib
import io
import json
import os
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

HOST = "0.0.0.0"
PORT = int(os.getenv("CHATTERBOX_PORT", "8001"))
AUTH_TOKEN = os.getenv("CHATTERBOX_AUTH_TOKEN", "").strip()
DEVICE = os.getenv("CHATTERBOX_DEVICE", "cuda")
VOICE_CACHE = Path("/workspace/voice-cache")
LIVEPORTRAIT_DIR = Path("/workspace/LivePortrait")
IDLE_STAMP = Path("/workspace/last-used")
MAX_TEXT = 2000
MAX_FETCH_BYTES = 30 * 1024 * 1024

VOICE_CACHE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="RIVR Chatterbox Worker")


def require_auth(authorization: Optional[str]) -> None:
    if not AUTH_TOKEN:
        return
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def touch_idle_stamp() -> None:
    try:
        IDLE_STAMP.write_text(str(int(__import__("time").time())))
    except Exception:
        pass


def fetch_to_file(url: str, dest: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "rivr-chatterbox"})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(MAX_FETCH_BYTES + 1)
    if not data or len(data) > MAX_FETCH_BYTES:
        raise HTTPException(status_code=422, detail="voice/image fetch empty or too large")
    dest.write_bytes(data)


def cached_fetch(url: str, suffix: str) -> Path:
    digest = hashlib.sha256(url.encode()).hexdigest()[:24]
    dest = VOICE_CACHE / f"{digest}{suffix}"
    if not dest.is_file():
        fetch_to_file(url, dest)
    return dest


_model = None
_model_lock = __import__("threading").Lock()
_model_error: Optional[str] = None


def load_model():
    global _model, _model_error
    with _model_lock:
        if _model is None:
            try:
                from chatterbox.tts import ChatterboxTTS
                _model = ChatterboxTTS.from_pretrained(device=DEVICE)
                _model_error = None
            except Exception as exc:  # noqa: BLE001
                _model_error = str(exc)[:400]
                raise
    return _model


def _preload_model_async() -> None:
    """Kick the model load at boot so 'ready' means READY (first request
    otherwise pays a multi-minute download and callers fall back)."""
    import threading

    def run():
        try:
            load_model()
            print("model preloaded", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"model preload failed: {exc}", flush=True)

    threading.Thread(target=run, daemon=True).start()


def to_float32_mono(wav) -> np.ndarray:
    arr = np.asarray(wav, dtype=np.float32)
    if hasattr(arr, "squeeze"):
        arr = arr.squeeze()
    if arr.ndim == 2:
        arr = arr.mean(axis=0)
    return arr


def encode_audio(wav: np.ndarray, sample_rate: int, fmt: str):
    fmt = (fmt or "wav").lower()
    with tempfile.TemporaryDirectory() as tmpdir:
        wav_path = Path(tmpdir) / "speech.wav"
        sf.write(wav_path, wav, sample_rate, subtype="PCM_16")
        if fmt == "wav":
            return wav_path.read_bytes(), "audio/wav"
        out_path = Path(tmpdir) / f"speech.{fmt}"
        codec = {"mp3": ["-codec:a", "libmp3lame", "-b:a", "96k"],
                 "opus": ["-codec:a", "libopus", "-b:a", "48k"]}.get(fmt)
        if not codec:
            raise HTTPException(status_code=400, detail=f"unsupported format {fmt}")
        proc = subprocess.run(["ffmpeg", "-y", "-i", str(wav_path), *codec, str(out_path)],
                              capture_output=True, text=True)
        if proc.returncode != 0:
            raise HTTPException(status_code=500, detail="ffmpeg encode failed")
        media = "audio/mpeg" if fmt == "mp3" else "audio/ogg"
        return out_path.read_bytes(), media


class TtsRequest(BaseModel):
    text: str
    voice_url: str
    response_format: Optional[str] = "wav"


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "rivr-chatterbox",
        "device": DEVICE,
        "model_loaded": _model is not None,
        "model_error": _model_error,
        # Ready only when the onstart stamped deps-done AFTER pip finished —
        # inference.py existing alone races the still-running installs.
        "liveportrait_ready": (LIVEPORTRAIT_DIR / ".deps-done").is_file(),
    }


@app.post("/tts")
def tts(req: TtsRequest, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    text = (req.text or "").strip()[:MAX_TEXT]
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not req.voice_url:
        raise HTTPException(status_code=400, detail="voice_url is required")

    voice_path = cached_fetch(req.voice_url, ".wav")
    model = load_model()
    wav = model.generate(text, audio_prompt_path=str(voice_path))
    wav_np = to_float32_mono(wav.cpu().numpy() if hasattr(wav, "cpu") else wav)
    audio_bytes, media_type = encode_audio(wav_np, model.sr, req.response_format or "wav")
    return Response(content=audio_bytes, media_type=media_type)


# ---------------------------------------------------------------------------
# Viseme-pack bake (one-time per portrait)
# ---------------------------------------------------------------------------

VISEME_BINS = ["closed", "slight", "open", "wide_open", "round", "wide"]


def classify_mouth(landmarks, width, height):
    """Returns (mar, width_ratio) from FaceMesh landmarks."""
    def px(i):
        lm = landmarks[i]
        return np.array([lm.x * width, lm.y * height])
    upper, lower = px(13), px(14)
    left, right = px(61), px(291)
    eye_l, eye_r = px(159), px(386)
    mouth_w = np.linalg.norm(right - left) + 1e-6
    face_w = np.linalg.norm(eye_r - eye_l) * 2.6 + 1e-6
    mar = np.linalg.norm(lower - upper) / mouth_w
    return float(mar), float(mouth_w / face_w)


def bin_for(mar, width_ratio):
    if mar < 0.04:
        return "closed"
    if mar > 0.12 and width_ratio < 0.62:
        return "round"
    if mar > 0.30:
        return "wide_open"
    if width_ratio > 0.78 and mar < 0.20:
        return "wide"
    if mar > 0.14:
        return "open"
    return "slight"


class VisemeRequest(BaseModel):
    image_url: str


# Bake jobs run in a worker thread and are fetched by id — the Vast port
# forward kills long-idle HTTP connections, so the bake must never be a
# single long request.
_bake_jobs: dict = {}


@app.post("/viseme-pack")
def viseme_pack_start(req: VisemeRequest, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    if not (LIVEPORTRAIT_DIR / ".deps-done").is_file():
        raise HTTPException(status_code=503, detail="LivePortrait still installing on this box")

    import threading
    import uuid as _uuid

    job_id = _uuid.uuid4().hex[:16]
    _bake_jobs[job_id] = {"status": "running"}

    def run():
        try:
            result = _run_viseme_bake(req.image_url)
            _bake_jobs[job_id] = {"status": "done", **result}
        except HTTPException as exc:
            _bake_jobs[job_id] = {"status": "error", "detail": str(exc.detail)}
        except Exception as exc:  # noqa: BLE001
            _bake_jobs[job_id] = {"status": "error", "detail": str(exc)[:400]}
        finally:
            touch_idle_stamp()

    threading.Thread(target=run, daemon=True).start()
    return {"jobId": job_id, "status": "running"}


@app.get("/viseme-pack/{job_id}")
def viseme_pack_status(job_id: str, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    job = _bake_jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="unknown bake job")
    return job


def _run_viseme_bake(image_url: str) -> dict:
    import cv2
    import mediapipe as mp

    portrait = cached_fetch(image_url, ".jpg")
    driving = None
    for candidate in sorted((LIVEPORTRAIT_DIR / "assets" / "examples" / "driving").glob("*.mp4")):
        driving = candidate
        if candidate.name in ("d6.mp4", "d0.mp4"):
            break
    if driving is None:
        raise HTTPException(status_code=503, detail="no driving clip available")

    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "out"
        out_dir.mkdir()
        lp_python = "/workspace/lp-venv/bin/python"
        if not Path(lp_python).is_file():
            lp_python = "python"
        proc = subprocess.run(
            [lp_python, "inference.py", "-s", str(portrait), "-d", str(driving),
             "-o", str(out_dir), "--flag-force-cpu" if DEVICE == "cpu" else "--no-flag-force-cpu"],
            cwd=str(LIVEPORTRAIT_DIR), capture_output=True, text=True, timeout=600,
        )
        videos = list(out_dir.rglob("*.mp4"))
        if proc.returncode != 0 or not videos:
            raise HTTPException(status_code=500,
                                detail=f"LivePortrait failed: {proc.stderr[-400:]}")
        # Prefer the non-concat output (portrait-only render).
        videos.sort(key=lambda p: ("concat" in p.name, len(p.name)))
        video = videos[0]

        capture = cv2.VideoCapture(str(video))
        mesh = mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1)
        best = {}
        targets = {"closed": 0.02, "slight": 0.09, "open": 0.20,
                   "wide_open": 0.38, "round": 0.18, "wide": 0.12}
        frame_index = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            frame_index += 1
            result = mesh.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if not result.multi_face_landmarks:
                continue
            height, width = frame.shape[:2]
            mar, wr = classify_mouth(result.multi_face_landmarks[0].landmark, width, height)
            label = bin_for(mar, wr)
            score = abs(mar - targets[label])
            if label not in best or score < best[label][0]:
                ok2, png = cv2.imencode(".png", frame)
                if ok2:
                    best[label] = (score, png.tobytes())
        capture.release()
        mesh.close()

    if "closed" not in best and best:
        # guarantee a rest frame: reuse the least-open capture
        first_label = min(best, key=lambda k: targets[k])
        best["closed"] = best[first_label]
    # Two bins (rest + one open shape) already animate convincingly via the
    # frame-swap engine's fallback ordering; more bins refine it.
    if len(best) < 2:
        raise HTTPException(status_code=422,
                            detail=f"could not extract enough mouth shapes (got {len(best)})")

    frames = {label: base64.b64encode(data).decode() for label, (_, data) in best.items()}
    return {"frames": frames, "bins": list(frames.keys())}


if __name__ == "__main__":
    _preload_model_async()
    uvicorn.run(app, host=HOST, port=PORT)
`;

/**
 * Onstart script for the Vast instance — the DURABLE, proven recipe
 * (verified live). It runs the MAINTAINED devnen Chatterbox TTS server,
 * which solves the dependency avalanche internally (installs chatterbox
 * with --no-deps + a locked version set). We add one protobuf bump the
 * base image needs, download the user's voice sample as the clone
 * reference, and self-STOP after 35 idle minutes.
 *
 * Install is guarded by a completion stamp so a box stopped mid-install
 * resumes on restart. `voiceSampleUrl` is a public URL to the user's
 * stored sample (any ffmpeg-decodable format; converted to voice.wav).
 */
export function buildOnstartScript(options: {
  voiceSampleUrl: string;
}): string {
  return String.raw`#!/bin/bash
set -x
exec >> /workspace/onstart.log 2>&1
apt-get update -y && apt-get install -y git ffmpeg libgl1 libglib2.0-0 curl
# --- Maintained Chatterbox server (install once; resume-safe) ---
if [ ! -f /workspace/cbx/.ready ]; then
  [ -d /workspace/cbx ] || git clone --depth 1 https://github.com/devnen/Chatterbox-TTS-Server /workspace/cbx
  cd /workspace/cbx
  # Their locked CUDA-12.1 torch + explicit deps. chatterbox itself installs
  # with --no-deps (the key that avoids the torch/onnx/protobuf avalanche).
  pip install --no-cache-dir -r requirements-nvidia.txt && \
  pip install --no-cache-dir --no-deps git+https://github.com/devnen/chatterbox-v2.git@master s3tokenizer==0.3.0 onnx==1.16.0 && \
  pip install --no-cache-dir "protobuf>=4.25.3,<5" && \
  touch /workspace/cbx/.ready
fi
cd /workspace/cbx
# --- Load the user's voice as the clone reference (every boot) ---
mkdir -p reference_audio
curl -fsSL "${options.voiceSampleUrl}" -o /tmp/ref.audio && ffmpeg -y -i /tmp/ref.audio reference_audio/voice.wav
# --- Idle self-stop (35 min without a synthesis touches last-used) ---
cat > /workspace/idle.sh <<'WATCHDOG'
#!/bin/bash
while true; do
  sleep 300
  S=/workspace/last-used
  [ -f "$S" ] || date +%s > "$S"
  L=$(cat "$S" 2>/dev/null || echo 0); N=$(date +%s)
  [ $((N - L)) -gt 2100 ] && shutdown -h now
done
WATCHDOG
chmod +x /workspace/idle.sh
nohup /workspace/idle.sh >/dev/null 2>&1 &
date +%s > /workspace/last-used
python3 server.py
`;
}
