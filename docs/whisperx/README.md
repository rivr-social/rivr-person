# WhisperX Transcription Service

Self-hosted speech recognition with speaker diarization for rivr-person, powered by [WhisperX](https://github.com/m-bain/whisperx).

## Prerequisites

- Docker and Docker Compose
- (Optional) A HuggingFace token for speaker diarization -- get one at https://huggingface.co/settings/tokens and accept the pyannote model terms at https://huggingface.co/pyannote/speaker-diarization-3.1

## Quick Start

```bash
cd rivr-person/docs/whisperx

# Build and start (CPU mode)
docker compose -f docker-compose.whisperx.yml up -d --build

# Verify it is running
curl http://localhost:9200/health
# => {"status":"ok","service":"whisperx"}
```

## Configuration

Set these environment variables (or add them to a `.env` file alongside the compose file):

| Variable | Default | Description |
|---|---|---|
| `WHISPERX_MODEL` | `base` | Model size: `tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3` |
| `WHISPERX_DEVICE` | `cpu` | `cpu` or `cuda` (GPU) |
| `WHISPERX_COMPUTE_TYPE` | `int8` | `int8` (CPU), `float16` (GPU), `float32` |
| `WHISPERX_BATCH_SIZE` | `16` | Inference batch size -- lower for less memory |
| `HF_TOKEN` | (empty) | HuggingFace token for speaker diarization |
| `WHISPERX_API_KEY` | (empty) | Bearer token to protect the endpoint |

## Connecting to rivr-person

Add these to the rivr-person container environment:

```env
WHISPER_TRANSCRIBE_URL=http://whisperx:9200/
WHISPER_TRANSCRIBE_API_KEY=<same value as WHISPERX_API_KEY, if set>
WHISPER_TRANSCRIBE_MODEL=base
```

When using Docker Lab compose chain, both containers must share the same Docker network.

## Docker Lab Integration

To add WhisperX to the PM Core Docker Lab stack, include this compose file in the chain:

```bash
docker compose \
  -f docker-compose.yml \
  -f /path/to/docker-compose.whisperx.yml \
  up -d
```

Or add the service definition directly into the main `docker-compose.yml`.

## GPU Support

Uncomment the `deploy` section in `docker-compose.whisperx.yml` and change:

```env
WHISPERX_DEVICE=cuda
WHISPERX_COMPUTE_TYPE=float16
```

Requires the NVIDIA Container Toolkit to be installed on the host.

## API Reference

### `GET /health`

Returns `{"status": "ok", "service": "whisperx"}`.

### `POST /`

Transcribe an audio file.

**Request**: `multipart/form-data`
- `file` (required) -- audio file (wav, mp3, webm, ogg, m4a, mp4, flac, opus)
- `model` (optional) -- override the default model size

**Headers**:
- `Authorization: Bearer <key>` (required only if `API_KEY` is set)

**Response** (JSON):
```json
{
  "text": "Full transcript text joined from all segments.",
  "segments": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "Hello, how are you?",
      "speaker": "SPEAKER_00",
      "words": []
    }
  ],
  "language": "en"
}
```

The `text` field is what rivr-person's `extractTranscriptText()` reads. The `segments` array provides per-segment speaker labels and timestamps for downstream processing.

## Testing

```bash
curl -X POST http://localhost:9200/ \
  -F "file=@test-audio.webm" \
  -H "Authorization: Bearer your-api-key"
```

## Model Sizes

| Model | Parameters | English-only | VRAM (approx) |
|---|---|---|---|
| `tiny` | 39M | Good | ~1 GB |
| `base` | 74M | Good | ~1 GB |
| `small` | 244M | Good | ~2 GB |
| `medium` | 769M | Good | ~5 GB |
| `large-v2` | 1550M | Best | ~10 GB |
| `large-v3` | 1550M | Best | ~10 GB |

For CPU-only deployments, `base` or `small` are recommended. The first request after startup will be slow while the model loads into memory.
