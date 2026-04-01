# Issue: WhisperX Live Event Transcription Pipeline

## Summary

Deploy [WhisperX](https://github.com/m-bain/whisperx) as the self-hosted speech recognition backend and wire it into the live event flow so group members can press record during meetings and have their speech transcribed into attendee-specific event documents with an event-level aggregate view.

## Context

The transcript storage pipeline already exists:
- `appendEventTranscriptAction()` appends segments to event-linked documents
- `ensureEventTranscriptDocument()` creates a transcript doc on first write
- `EventTranscriptPanel` component provides recording UI
- `src/lib/transcription.ts` has dual-provider support (Whisper gateway + OpenAI fallback)
- MCP tool `rivr.events.append_transcript` enables autobot transcription
- `.env.example` has `WHISPER_TRANSCRIBE_URL` ready

What's missing is the **WhisperX deployment**, the **live event flow integration**, and the shift from one shared transcript doc to per-attendee transcript docs.

## Requirements

### WhisperX Service
- Deploy WhisperX as a Docker service in PM Core / Docker Lab
- Expose REST API compatible with the existing `WHISPER_TRANSCRIBE_URL` pattern
- Enable speaker diarization (WhisperX's key feature over vanilla Whisper)
- Model: large-v3 for accuracy, or medium for speed on constrained hardware
- GPU support optional — WhisperX supports CPU inference

### Live Invite → Meeting Event → Transcription Flow
When a user creates a **live invite post** with a group:
1. The live invite post is created (already works)
2. A linked **meeting event** is created (already works via `maybeCreateLinkedMeetingBundle`)
3. A linked **transcript workspace** is created in the group's docs
4. All group members who RSVP "going" should see a **Record** button in the event view
5. Pressing Record → browser MediaRecorder captures audio → uploads to `/api/events/[id]/transcribe`
6. WhisperX transcribes with speaker diarization → segments appended to that attendee's event transcript document
7. The event detail view shows both attendee transcript docs and an aggregated transcript view
8. Transcript materials are visible in real-time in the group's documents tab

### What Needs Building
- [ ] WhisperX Docker service definition for PM Core
- [ ] Verify `WHISPER_TRANSCRIBE_URL` integration works end-to-end with WhisperX API format
- [ ] Ensure `EventTranscriptPanel` is rendered for all RSVP'd members during active events
- [ ] Create attendee-specific transcript documents instead of a single shared transcript target
- [ ] Add event-level transcript aggregation across attendee docs
- [ ] Add speaker diarization labels from WhisperX response (currently `speakerLabel` is manual)
- [ ] Add chunked upload for long recordings (current: single file upload)
- [ ] Surface transcript workspace and attendee document links prominently in event detail view

## Technical Notes

- WhisperX repo: https://github.com/m-bain/whisperx
- WhisperX adds word-level timestamps + speaker diarization on top of Whisper
- API compatibility: WhisperX can run behind a FastAPI wrapper that matches OpenAI Whisper API format
- Existing transcription code in `src/lib/transcription.ts` sends `multipart/form-data` with audio file
- Speaker diarization output format: segments with `speaker` field — map to `speakerLabel` in append action
- Current implementation appends to one event transcript doc; target implementation should pivot to per-attendee docs plus aggregate event transcript rendering
- PM Core Docker Lab is the deployment target for the WhisperX service

## Where This Fits

- PM Core / Docker Lab: new `whisperx` service in docker-compose
- rivr-person `.env`: `WHISPER_TRANSCRIBE_URL=http://whisperx:8000/transcribe`
- Event detail page: transcript panel for RSVP'd members
- Group documents tab: attendee transcript docs appear automatically
- Event detail page: aggregate transcript view assembled from attendee docs
- MCP: autobots can also append transcripts via `rivr.events.append_transcript`

## Priority

High — this completes the meeting → transcript → group knowledge pipeline while avoiding write contention and muddled authorship in a single shared transcript doc.
