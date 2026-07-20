# Live-avatar worker

Realtime "talking picture" service for the rivr-person live avatar mode:
one reference portrait in, a continuous MJPEG stream out, mouth motion
driven by the speech audio the assistant is saying (or a text-timing
fallback when no server-side audio exists).

## How it animates (and why it's light)

This is deliberately **not** a generative-video model. The engine
(`engine.py`) locates the mouth and eyes once per session with MediaPipe
FaceMesh, precomputes jaw-drop and blink displacement fields, and warps
the portrait per frame with `cv2.remap` plus inner-mouth shading, idle
head-sway, and Poisson blinks. A 512px frame renders in ~1–2ms on CPU at
8fps, so a session costs effectively nothing and the service runs
anywhere — including GPU hosts where the GPU stays free for TTS.

Images with no detectable face (cartoons, statues) fall back to a
plausible mouth/eye layout so any picture still talks.

The worker API is engine-agnostic: a LivePortrait/FasterLivePortrait
engine can replace `engine.py` (same `build_rig`/`render_frame` surface)
for photoreal motion without touching the app integration. See
`docs/reports/photorealistic-cameron-clone-pipeline.md` for that lane.

## API

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/health` | — | status + session count |
| POST | `/sessions` | JSON `{reference_image_url}` or multipart `file` | `{sessionId, width, height, faceDetected, fps}` |
| GET | `/sessions/{id}` | — | status |
| DELETE | `/sessions/{id}` | — | `{ok}` |
| POST | `/sessions/{id}/speak` | multipart audio `file` OR JSON `{text, durationMs?}` | `{ok, durationMs, frames, source}` |
| POST | `/sessions/{id}/stop-speaking` | — | `{ok}` (barge-in) |
| GET | `/sessions/{id}/stream` | — | `multipart/x-mixed-replace` MJPEG |

Auth: optional `API_KEY` env → `Authorization: Bearer` (the `/stream`
endpoint also accepts `?key=` because `<img>` tags cannot send headers;
the rivr-person proxy always uses the header).

## Environment

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8012` | listen port |
| `API_KEY` | unset | optional bearer auth |
| `AVATAR_FPS` | `8` | animation/stream framerate |
| `MAX_SESSIONS` | `8` | concurrent session cap |
| `SESSION_IDLE_TIMEOUT` | `900` | seconds before an unwatched session is reaped |
| `FETCH_TIMEOUT_S` | `20` | reference-image download timeout |

## Deploy

Anywhere Docker runs — the camalot host, the sidecar stack, or a Vast.ai
instance next to Chatterbox TTS. Point rivr-person's
`LIVE_AVATAR_WORKER_URL` (+ `LIVE_AVATAR_WORKER_API_KEY`) at it.

```bash
docker build -t live-avatar-worker .
docker run -d --restart unless-stopped -p 8012:8012 -e API_KEY=... live-avatar-worker
```

## Tests

```bash
pip install -r requirements.txt pytest
pytest test_worker.py
```
