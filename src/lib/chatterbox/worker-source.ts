/**
 * RIVR GPU sidecar — python source, served to the Vast instance at boot
 * via GET /api/autobot/gpu/worker-source (the onstart curls it EVERY boot
 * and runs it; no registry, no scp — sidecar code updates ship with app
 * deploys, only the installed deps are baked on the box).
 *
 * The box runs TWO servers:
 *   :8004  devnen Chatterbox-TTS-Server — the VOICE lane (untouched, the
 *          proven --no-deps recipe; /tts clone shape, /docs 200 = ready)
 *   :8005  THIS sidecar — the FACE lane:
 *     GET  /health                     — liveness + which engines are ready
 *     POST /viseme-pack {image_url}    — bake job: LivePortrait drives the
 *          portrait, frames classify into mouth bins + a 12-step openness
 *          LADDER (real in-between shapes for transitions) + eye/brow
 *          region variants (blink + expression compositing)
 *     GET  /viseme-pack/{jobId}        — poll bake result
 *     POST /animate {audio_b64, audio_mime, image_b64}
 *          — GPU-live job: Wav2Lip renders the portrait actually SPEAKING
 *          the reply audio; returns JPEG frames + fps for the worker to
 *          relay into the MJPEG stream. Optional lane — everything falls
 *          back to the baked pack when this is missing or slow.
 *     GET  /animate/{jobId}            — poll animate result
 *
 * All heavy installs are resume-guarded and ISOLATED from the voice lane
 * (own venvs); a failed sidecar install never blocks the cloned voice.
 */

/** devnen Chatterbox voice server port (the app probes /docs on this). */
export const CHATTERBOX_WORKER_PORT = 8004;

/** RIVR sidecar (bake + animate) port. */
export const SIDECAR_WORKER_PORT = 8005;

export const CHATTERBOX_WORKER_SOURCE = String.raw`#!/usr/bin/env python3
"""RIVR GPU sidecar: viseme-pack bake (LivePortrait) + gpu-live animate (Wav2Lip)."""
import base64
import hashlib
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import os

HOST = "0.0.0.0"
PORT = int(os.getenv("SIDECAR_PORT", "8005"))
AUTH_TOKEN = os.getenv("SIDECAR_AUTH_TOKEN", "").strip()
FETCH_CACHE = Path("/workspace/fetch-cache")
LIVEPORTRAIT_DIR = Path("/workspace/LivePortrait")
LP_PYTHON = Path("/workspace/lp-venv/bin/python")
WAV2LIP_DIR = Path("/workspace/Wav2Lip")
W2L_PYTHON = Path("/workspace/w2l-venv/bin/python")
IDLE_STAMP = Path("/workspace/last-used")
MAX_FETCH_BYTES = 30 * 1024 * 1024
MAX_AUDIO_B64 = 20 * 1024 * 1024
MAX_IMAGE_B64 = 16 * 1024 * 1024
LADDER_STEPS = 12
ANIMATE_MAX_FRAMES = 900          # 36s at 25fps
ANIMATE_MAX_DIM = 512
ANIMATE_JPEG_QUALITY = 82
BAKE_TIMEOUT_S = 600
ANIMATE_TIMEOUT_S = 240
POSE_TOLERANCE = 0.025            # of frame diagonal, for region alignment

FETCH_CACHE.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="RIVR GPU Sidecar")


def require_auth(authorization: Optional[str]) -> None:
    if not AUTH_TOKEN:
        return
    if authorization != f"Bearer {AUTH_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def touch_idle_stamp() -> None:
    try:
        IDLE_STAMP.write_text(str(int(time.time())))
    except Exception:
        pass


def cached_fetch(url: str, suffix: str) -> Path:
    digest = hashlib.sha256(url.encode()).hexdigest()[:24]
    dest = FETCH_CACHE / f"{digest}{suffix}"
    if not dest.is_file():
        request = urllib.request.Request(url, headers={"User-Agent": "rivr-sidecar"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(MAX_FETCH_BYTES + 1)
        if not data or len(data) > MAX_FETCH_BYTES:
            raise HTTPException(status_code=422, detail="fetch empty or too large")
        dest.write_bytes(data)
    return dest


def liveportrait_ready() -> bool:
    return (LIVEPORTRAIT_DIR / ".deps-done").is_file() and LP_PYTHON.is_file()


def wav2lip_ready() -> bool:
    return (WAV2LIP_DIR / ".deps-done").is_file() and W2L_PYTHON.is_file()


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "rivr-sidecar",
        "liveportrait_ready": liveportrait_ready(),
        "wav2lip_ready": wav2lip_ready(),
    }


# ---------------------------------------------------------------------------
# Job registry — Vast's port forward kills long-held HTTP connections, so
# every heavy operation is a start-then-poll job, never one long request.
# ---------------------------------------------------------------------------

_jobs: dict = {}


def _start_job(kind: str, runner) -> dict:
    job_id = uuid.uuid4().hex[:16]
    _jobs[job_id] = {"status": "running", "kind": kind}

    def run():
        try:
            result = runner()
            _jobs[job_id] = {"status": "done", "kind": kind, **result}
        except HTTPException as exc:
            _jobs[job_id] = {"status": "error", "kind": kind, "detail": str(exc.detail)}
        except Exception as exc:  # noqa: BLE001
            _jobs[job_id] = {"status": "error", "kind": kind, "detail": str(exc)[:400]}
        finally:
            touch_idle_stamp()

    threading.Thread(target=run, daemon=True).start()
    return {"jobId": job_id, "status": "running"}


def _poll_job(job_id: str, kind: str) -> dict:
    job = _jobs.get(job_id)
    if job is None or job.get("kind") != kind:
        raise HTTPException(status_code=404, detail="unknown job")
    return job


# ---------------------------------------------------------------------------
# Face measurement (MediaPipe FaceMesh)
# ---------------------------------------------------------------------------

VISEME_BINS = ["closed", "slight", "open", "wide_open", "round", "wide"]
BIN_TARGETS = {"closed": 0.02, "slight": 0.09, "open": 0.20,
               "wide_open": 0.38, "round": 0.18, "wide": 0.12}


def measure_face(landmarks, width, height):
    """Mouth/eye/brow/pose metrics from FaceMesh landmarks."""
    def px(i):
        lm = landmarks[i]
        return np.array([lm.x * width, lm.y * height])

    upper, lower = px(13), px(14)
    left, right = px(61), px(291)
    eye_l, eye_r = px(159), px(386)
    mouth_w = np.linalg.norm(right - left) + 1e-6
    face_w = np.linalg.norm(eye_r - eye_l) * 2.6 + 1e-6

    # Eye openness (EAR-ish): lid gap over eye width, averaged.
    def eye_open(upper_i, lower_i, inner_i, outer_i):
        gap = np.linalg.norm(px(lower_i) - px(upper_i))
        span = np.linalg.norm(px(outer_i) - px(inner_i)) + 1e-6
        return gap / span

    ear = (eye_open(159, 145, 33, 133) + eye_open(386, 374, 362, 263)) / 2.0
    # Brow raise: brow-to-eye distance normalized by face width.
    brow = (np.linalg.norm(px(105) - px(159)) + np.linalg.norm(px(334) - px(386))) / (
        2.0 * face_w
    )
    # Pose key for region alignment: nose + both eyes, diag-normalized.
    diag = float(np.hypot(width, height))
    pose = np.concatenate([px(1), eye_l, eye_r]) / diag

    return {
        "mar": float(np.linalg.norm(lower - upper) / mouth_w),
        "width_ratio": float(mouth_w / face_w),
        "ear": float(ear),
        "brow": float(brow),
        "pose": pose,
    }


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


# ---------------------------------------------------------------------------
# Viseme-pack bake (LivePortrait pass -> bins + ladder + regions)
# ---------------------------------------------------------------------------


class VisemeRequest(BaseModel):
    image_url: str


@app.post("/viseme-pack")
def viseme_pack_start(req: VisemeRequest, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    if not liveportrait_ready():
        raise HTTPException(status_code=503, detail="LivePortrait still installing on this box")
    return _start_job("bake", lambda: _run_viseme_bake(req.image_url))


@app.get("/viseme-pack/{job_id}")
def viseme_pack_status(job_id: str, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    return _poll_job(job_id, "bake")


def _render_liveportrait(portrait: Path, out_dir: Path) -> Path:
    driving = None
    for candidate in sorted((LIVEPORTRAIT_DIR / "assets" / "examples" / "driving").glob("*.mp4")):
        driving = candidate
        if candidate.name in ("d6.mp4", "d0.mp4"):
            break
    if driving is None:
        raise HTTPException(status_code=503, detail="no driving clip available")
    proc = subprocess.run(
        [str(LP_PYTHON), "inference.py", "-s", str(portrait), "-d", str(driving),
         "-o", str(out_dir)],
        cwd=str(LIVEPORTRAIT_DIR), capture_output=True, text=True, timeout=BAKE_TIMEOUT_S,
    )
    videos = list(out_dir.rglob("*.mp4"))
    if proc.returncode != 0 or not videos:
        raise HTTPException(status_code=500, detail=f"LivePortrait failed: {proc.stderr[-400:]}")
    videos.sort(key=lambda p: ("concat" in p.name, len(p.name)))
    return videos[0]


def _run_viseme_bake(image_url: str) -> dict:
    import cv2
    import mediapipe as mp

    portrait = cached_fetch(image_url, ".jpg")
    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = Path(tmpdir) / "out"
        out_dir.mkdir()
        video = _render_liveportrait(portrait, out_dir)

        capture = cv2.VideoCapture(str(video))
        mesh = mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1)
        samples = []  # (metrics, png_bytes)
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            result = mesh.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            if not result.multi_face_landmarks:
                continue
            height, width = frame.shape[:2]
            metrics = measure_face(result.multi_face_landmarks[0].landmark, width, height)
            ok2, png = cv2.imencode(".png", frame)
            if ok2:
                samples.append((metrics, png.tobytes()))
        capture.release()
        mesh.close()

    if len(samples) < 4:
        raise HTTPException(status_code=422,
                            detail=f"could not measure enough frames (got {len(samples)})")

    frames: dict[str, bytes] = {}

    # 1. Best frame per mouth bin (unchanged classification).
    best: dict[str, tuple[float, bytes]] = {}
    for metrics, png in samples:
        label = bin_for(metrics["mar"], metrics["width_ratio"])
        score = abs(metrics["mar"] - BIN_TARGETS[label])
        if label not in best or score < best[label][0]:
            best[label] = (score, png)
    for label, (_, png) in best.items():
        frames[label] = png

    # 2. Openness LADDER: quantile frames along mouth-aspect-ratio, shape-
    # neutral (rounded frames excluded so the ladder reads as one motion).
    neutral = sorted(
        ((m["mar"], png) for m, png in samples if m["width_ratio"] >= 0.62),
        key=lambda item: item[0],
    )
    if len(neutral) >= LADDER_STEPS:
        for step in range(LADDER_STEPS):
            index = round(step * (len(neutral) - 1) / (LADDER_STEPS - 1))
            frames[f"step_{step:02d}"] = neutral[index][1]

    # 3. Region variants for blink/brow compositing — only frames whose head
    # pose matches the rest frame (compositing misaligns otherwise).
    rest_metrics = None
    if "closed" in best:
        for metrics, png in samples:
            if png is best["closed"][1]:
                rest_metrics = metrics
                break
    if rest_metrics is not None:
        def pose_ok(metrics):
            return float(np.max(np.abs(metrics["pose"] - rest_metrics["pose"]))) < POSE_TOLERANCE

        eyes = [(m["ear"], png) for m, png in samples if pose_ok(m)]
        if eyes:
            min_ear, min_png = min(eyes, key=lambda item: item[0])
            rest_ear = rest_metrics["ear"]
            if min_ear < rest_ear * 0.45:  # genuinely shut, not squint
                frames["eyes_closed"] = min_png
        brows = [(m["brow"], png) for m, png in samples if pose_ok(m)]
        if brows:
            max_brow, max_png = max(brows, key=lambda item: item[0])
            if max_brow > rest_metrics["brow"] * 1.12:
                frames["brows_raised"] = max_png

    if "closed" not in frames and best:
        first_label = min(best, key=lambda k: BIN_TARGETS[k])
        frames["closed"] = best[first_label][1]
    if len([k for k in frames if k in VISEME_BINS]) < 2:
        raise HTTPException(status_code=422, detail="could not extract enough mouth shapes")

    encoded = {label: base64.b64encode(data).decode() for label, data in frames.items()}
    return {"frames": encoded, "bins": list(encoded.keys())}


# ---------------------------------------------------------------------------
# GPU-live animate (Wav2Lip: portrait + reply audio -> speaking frames)
# ---------------------------------------------------------------------------


class AnimateRequest(BaseModel):
    audio_b64: str
    audio_mime: Optional[str] = "audio/mpeg"
    image_b64: str


@app.post("/animate")
def animate_start(req: AnimateRequest, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    if not wav2lip_ready():
        raise HTTPException(status_code=503, detail="Wav2Lip still installing on this box")
    if len(req.audio_b64) > MAX_AUDIO_B64 or len(req.image_b64) > MAX_IMAGE_B64:
        raise HTTPException(status_code=413, detail="audio or image too large")
    return _start_job("animate", lambda: _run_animate(req))


@app.get("/animate/{job_id}")
def animate_status(job_id: str, authorization: Optional[str] = Header(default=None)):
    require_auth(authorization)
    touch_idle_stamp()
    return _poll_job(job_id, "animate")


def _run_animate(req: AnimateRequest) -> dict:
    import cv2

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        raw_audio = tmp / "reply.audio"
        raw_audio.write_bytes(base64.b64decode(req.audio_b64))
        wav = tmp / "reply.wav"
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", str(raw_audio), "-ac", "1", "-ar", "16000", str(wav)],
            capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0:
            raise HTTPException(status_code=422, detail="audio decode failed")
        face = tmp / "face.jpg"
        face.write_bytes(base64.b64decode(req.image_b64))
        out = tmp / "out.mp4"

        proc = subprocess.run(
            [str(W2L_PYTHON), "inference.py",
             "--checkpoint_path", "checkpoints/wav2lip_gan.pth",
             "--face", str(face), "--audio", str(wav),
             "--outfile", str(out), "--nosmooth"],
            cwd=str(WAV2LIP_DIR), capture_output=True, text=True,
            timeout=ANIMATE_TIMEOUT_S,
        )
        if proc.returncode != 0 or not out.is_file():
            raise HTTPException(status_code=500,
                                detail=f"Wav2Lip failed: {proc.stderr[-400:]}")

        capture = cv2.VideoCapture(str(out))
        fps = capture.get(cv2.CAP_PROP_FPS) or 25.0
        encoded: list[str] = []
        while len(encoded) < ANIMATE_MAX_FRAMES:
            ok, frame = capture.read()
            if not ok:
                break
            height, width = frame.shape[:2]
            scale = min(1.0, ANIMATE_MAX_DIM / max(height, width))
            if scale < 1.0:
                frame = cv2.resize(
                    frame,
                    (max(1, round(width * scale)), max(1, round(height * scale))),
                    interpolation=cv2.INTER_AREA,
                )
            ok2, jpeg = cv2.imencode(
                ".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, ANIMATE_JPEG_QUALITY],
            )
            if ok2:
                encoded.append(base64.b64encode(jpeg.tobytes()).decode())
        capture.release()

    if not encoded:
        raise HTTPException(status_code=500, detail="Wav2Lip produced no frames")
    return {"frames": encoded, "fps": float(fps)}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
`;

/**
 * Onstart script for the Vast instance.
 *
 * The VOICE lane is the proven devnen recipe from the 2026-07-21 acceptance
 * pass — its steps are intentionally untouched. The FACE lane (sidecar) is
 * added as isolated, resume-guarded background installs: a failed sidecar
 * install degrades bake/animate to 503 while the cloned voice keeps working.
 *
 * `voiceSampleUrl` — public URL of the user's stored clone sample.
 * `workerSourceUrl` — this instance's /api/autobot/gpu/worker-source; the
 * sidecar python is re-fetched EVERY boot so app deploys update it.
 */
export function buildOnstartScript(options: {
  voiceSampleUrl: string;
  workerSourceUrl: string;
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
# --- RIVR sidecar (bake + gpu-live animate): fetch fresh code every boot,
# --- install deps resume-guarded in ISOLATED venvs, run in background. ---
mkdir -p /workspace/sidecar
curl -fsSL "${options.workerSourceUrl}" -o /tmp/sidecar.py && mv /tmp/sidecar.py /workspace/sidecar/sidecar.py
cat > /workspace/sidecar/install.sh <<'SIDECARINSTALL'
#!/bin/bash
set -x
exec >> /workspace/sidecar-install.log 2>&1
if [ ! -f /workspace/sidecar/.venv-ready ]; then
  python3 -m venv /workspace/sidecar-venv
  /workspace/sidecar-venv/bin/pip install --no-cache-dir \
    fastapi uvicorn pydantic numpy opencv-python-headless mediapipe==0.10.14 && \
  touch /workspace/sidecar/.venv-ready
fi
if [ ! -f /workspace/LivePortrait/.deps-done ]; then
  [ -d /workspace/LivePortrait ] || git clone --depth 1 https://github.com/KwaiVGI/LivePortrait /workspace/LivePortrait
  python3 -m venv /workspace/lp-venv
  /workspace/lp-venv/bin/pip install --no-cache-dir -r /workspace/LivePortrait/requirements.txt && \
  /workspace/sidecar-venv/bin/pip install --no-cache-dir "huggingface_hub[cli]" && \
  /workspace/sidecar-venv/bin/huggingface-cli download KwaiVGI/LivePortrait \
    --local-dir /workspace/LivePortrait/pretrained_weights && \
  touch /workspace/LivePortrait/.deps-done
fi
if [ ! -f /workspace/Wav2Lip/.deps-done ]; then
  [ -d /workspace/Wav2Lip ] || git clone --depth 1 https://github.com/Rudrabha/Wav2Lip /workspace/Wav2Lip
  # Reuses the base image's torch (system site packages); adds only extras.
  python3 -m venv --system-site-packages /workspace/w2l-venv
  /workspace/w2l-venv/bin/pip install --no-cache-dir librosa==0.10.2 opencv-python-headless numba tqdm && \
  mkdir -p /workspace/Wav2Lip/checkpoints /workspace/Wav2Lip/face_detection/detection/sfd && \
  curl -fsSL "https://huggingface.co/camenduru/Wav2Lip/resolve/main/checkpoints/wav2lip_gan.pth" \
    -o /workspace/Wav2Lip/checkpoints/wav2lip_gan.pth && \
  curl -fsSL "https://huggingface.co/camenduru/Wav2Lip/resolve/main/checkpoints/s3fd-619a316812.pth" \
    -o /workspace/Wav2Lip/face_detection/detection/sfd/s3fd.pth && \
  touch /workspace/Wav2Lip/.deps-done
fi
SIDECARINSTALL
chmod +x /workspace/sidecar/install.sh
nohup bash -c 'bash /workspace/sidecar/install.sh; pkill -f "sidecar/sidecar.py" || true; SIDECAR_PORT=8005 /workspace/sidecar-venv/bin/python /workspace/sidecar/sidecar.py' >> /workspace/sidecar.log 2>&1 &
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
