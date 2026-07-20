# Live-avatar worker
#
# Realtime talking-picture MJPEG streams from a single portrait.
# Pairs with rivr-person's LIVE_AVATAR_WORKER_URL integration.
#
# Build:
#   docker build -t live-avatar-worker .
#
# Run:
#   docker run -p 8012:8012 -e API_KEY=... live-avatar-worker
#
# The engine is CPU-light (landmark warp, no generative model), so this
# image runs fine without a GPU; on a GPU host it simply leaves the GPU
# free for TTS/other workloads. A LivePortrait-class engine can replace
# engine.py behind the same API as a drop-in upgrade.

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# ffmpeg for audio-envelope decode; libgl/libglib for OpenCV + MediaPipe.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY engine.py audio_env.py app.py ./

ENV PORT=8012 \
    API_KEY="" \
    AVATAR_FPS=8 \
    MAX_SESSIONS=8 \
    SESSION_IDLE_TIMEOUT=900

EXPOSE 8012

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8012/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8012", "--workers", "1"]
