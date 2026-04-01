# WhisperX transcription service
#
# Provides a FastAPI endpoint for speech-to-text with speaker diarization.
# Compatible with rivr-person's WHISPER_TRANSCRIBE_URL integration.
#
# Build:
#   docker build -t whisperx-service .
#
# Run (CPU):
#   docker run -p 9200:9200 -e HF_TOKEN=hf_... whisperx-service

FROM python:3.11-slim AS base

# Prevent Python from writing .pyc files and enable unbuffered output.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install system dependencies required by WhisperX and ffmpeg for audio processing.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        git \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies.
# Pin versions for reproducible builds.
RUN pip install --no-cache-dir \
    "fastapi>=0.110,<1" \
    "uvicorn[standard]>=0.29,<1" \
    "python-multipart>=0.0.9" \
    "torch>=2.1,<3" \
    "torchaudio>=2.1,<3" \
    "whisperx @ git+https://github.com/m-bain/whisperx.git" \
    --extra-index-url https://download.pytorch.org/whl/cpu

COPY app.py .

# The service listens on port 9200 by default.
ENV WHISPERX_MODEL=base \
    WHISPERX_DEVICE=cpu \
    WHISPERX_COMPUTE_TYPE=int8 \
    WHISPERX_BATCH_SIZE=16 \
    HF_TOKEN="" \
    API_KEY="" \
    PORT=9200

EXPOSE 9200

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:9200/health')" || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "9200", "--workers", "1"]
