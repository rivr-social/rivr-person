"""
WhisperX transcription service -- FastAPI wrapper.

Accepts multipart/form-data audio uploads and returns transcription
results with optional speaker diarization via WhisperX.

API contract (compatible with rivr-person transcription.ts):
  Request:  POST / with form fields "file" (audio) and optional "model"
  Response: { "text": "...", "segments": [...], "language": "en" }

Environment variables:
  WHISPERX_MODEL        -- WhisperX model size (default: "base")
  WHISPERX_DEVICE       -- "cpu" or "cuda" (default: "cpu")
  WHISPERX_COMPUTE_TYPE -- "int8", "float16", "float32" (default: "int8")
  WHISPERX_BATCH_SIZE   -- Batch size for inference (default: 16)
  HF_TOKEN              -- HuggingFace token for diarization pipeline
  API_KEY               -- Optional Bearer token for authentication
"""

from __future__ import annotations

import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Any

import whisperx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = os.environ.get("WHISPERX_MODEL", "base")
DEVICE = os.environ.get("WHISPERX_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPERX_COMPUTE_TYPE", "int8")
BATCH_SIZE = int(os.environ.get("WHISPERX_BATCH_SIZE", "16"))
HF_TOKEN = os.environ.get("HF_TOKEN", "")
API_KEY = os.environ.get("API_KEY", "")

SUPPORTED_EXTENSIONS = {
    ".wav", ".mp3", ".flac", ".ogg", ".webm", ".m4a", ".mp4", ".opus",
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("whisperx-service")

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="WhisperX Transcription Service",
    version="1.0.0",
    description="Speech recognition with speaker diarization via WhisperX.",
)

# Cache the loaded model so it is only loaded once at startup.
_model_cache: dict[str, Any] = {}


def _get_model(model_name: str) -> Any:
    """Load (and cache) a WhisperX model by name."""
    if model_name not in _model_cache:
        logger.info("Loading WhisperX model '%s' on %s (%s)...", model_name, DEVICE, COMPUTE_TYPE)
        _model_cache[model_name] = whisperx.load_model(
            model_name,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
        )
        logger.info("Model '%s' loaded successfully.", model_name)
    return _model_cache[model_name]


def _validate_api_key(request: Request) -> None:
    """Validate the Bearer token if API_KEY is configured."""
    if not API_KEY:
        return
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header.")
    token = auth_header[len("Bearer "):]
    if token != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid API key.")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint for Docker HEALTHCHECK and load balancers."""
    return {"status": "ok", "service": "whisperx"}


@app.post("/")
async def transcribe(
    request: Request,
    file: UploadFile = File(..., description="Audio file to transcribe"),
    model: str = Form(default="", description="WhisperX model size override"),
) -> JSONResponse:
    """
    Transcribe an audio file with WhisperX and optional speaker diarization.

    Returns JSON compatible with rivr-person's extractTranscriptText():
      { "text": "full transcript", "segments": [...], "language": "en" }
    """
    _validate_api_key(request)

    # Determine model to use -- form field overrides env default.
    model_name = model.strip() if model and model.strip() else DEFAULT_MODEL

    # Validate file extension.
    suffix = Path(file.filename or "audio.webm").suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format '{suffix}'. Supported: {', '.join(sorted(SUPPORTED_EXTENSIONS))}",
        )

    # Write upload to a temp file so WhisperX can read it from disk.
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp_path = tmp.name
            contents = await file.read()
            if not contents:
                raise HTTPException(status_code=400, detail="Uploaded file is empty.")
            tmp.write(contents)

        start_time = time.monotonic()

        # Step 1: Load audio
        audio = whisperx.load_audio(tmp_path)

        # Step 2: Transcribe
        whisper_model = _get_model(model_name)
        result = whisper_model.transcribe(audio, batch_size=BATCH_SIZE)
        detected_language = result.get("language", "en")

        # Step 3: Align whisper output for word-level timestamps
        try:
            align_model, align_metadata = whisperx.load_align_model(
                language_code=detected_language,
                device=DEVICE,
            )
            result = whisperx.align(
                result["segments"],
                align_model,
                align_metadata,
                audio,
                DEVICE,
                return_char_alignments=False,
            )
        except Exception as align_err:
            logger.warning("Alignment failed (non-fatal): %s", align_err)

        # Step 4: Diarize (speaker labels) -- requires HF_TOKEN
        if HF_TOKEN:
            try:
                diarize_model = whisperx.DiarizationPipeline(
                    use_auth_token=HF_TOKEN,
                    device=DEVICE,
                )
                diarize_segments = diarize_model(audio)
                result = whisperx.assign_word_speakers(diarize_segments, result)
            except Exception as diarize_err:
                logger.warning("Diarization failed (non-fatal): %s", diarize_err)
        else:
            logger.info("HF_TOKEN not set -- skipping speaker diarization.")

        # Build response segments.
        segments = []
        for seg in result.get("segments", []):
            segments.append({
                "start": round(seg.get("start", 0.0), 3),
                "end": round(seg.get("end", 0.0), 3),
                "text": seg.get("text", "").strip(),
                "speaker": seg.get("speaker", None),
                "words": seg.get("words", []),
            })

        full_text = " ".join(seg["text"] for seg in segments if seg["text"])
        elapsed = round(time.monotonic() - start_time, 2)

        logger.info(
            "Transcription complete: lang=%s segments=%d chars=%d elapsed=%.2fs",
            detected_language, len(segments), len(full_text), elapsed,
        )

        return JSONResponse(content={
            "text": full_text,
            "segments": segments,
            "language": detected_language,
        })

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription error: {exc}") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
