# WebRTC Meetings, Video, and Livestreaming for Rivr

**Research Report -- March 2026**

Prepared for the Rivr platform engineering team. This report covers infrastructure options, architecture designs, and phased implementation plans for adding real-time meetings, training/webinar mode, livestreaming, and video/reels posting to Rivr.

---

## Table of Contents

1. [WebRTC Infrastructure Options](#1-webrtc-infrastructure-options)
2. [Meeting Rooms for Rivr Groups](#2-meeting-rooms-for-rivr-groups)
3. [Training / Webinar Mode](#3-training--webinar-mode)
4. [Livestreaming](#4-livestreaming)
5. [Video Posts and Reels](#5-video-posts-and-reels)
6. [Architecture: How It All Connects](#6-architecture-how-it-all-connects)
7. [PM Core Docker Services Needed](#7-pm-core-docker-services-needed)
8. [Cost Analysis](#8-cost-analysis)
9. [Rivr Integration Points](#9-rivr-integration-points)
10. [MVP Recommendation](#10-mvp-recommendation)

---

## 1. WebRTC Infrastructure Options

### 1.1 Self-Hosted Options

#### LiveKit (Recommended -- Already Partially Integrated)

LiveKit is an open-source WebRTC Selective Forwarding Unit (SFU) written in Go. Rivr already has partial integration through the Autobot token server (`Autobot/token-server/server.js`), which issues LiveKit JWT tokens using `livekit-server-sdk` and connects to a LiveKit WebSocket URL for the OpenClaw digital-human voice room.

**Core Components:**

| Component | Purpose | Docker Image | Resource Needs |
|-----------|---------|-------------|----------------|
| LiveKit Server | SFU + signaling + room management | `livekit/livekit-server` | 2-4 CPU, 2-4 GB RAM |
| LiveKit Egress | Recording to file, RTMP streaming, HLS output | `livekit/egress` | 4 CPU, 4 GB RAM per instance |
| LiveKit Ingress | Ingest RTMP/WHIP/SRT streams into rooms | `livekit/ingress` | 4 CPU, 4 GB RAM per instance |
| Redis | Pub/sub messaging between services | `redis:7-alpine` | 0.5 CPU, 512 MB RAM |
| Caddy | Reverse proxy, automatic TLS via Let's Encrypt | `caddy:2` | Minimal |

**Benchmark Data (from LiveKit official benchmarks on 16-core c2-standard-16 GCP instance):**

| Scenario | Publishers | Subscribers | CPU Usage | Inbound BW | Outbound BW |
|----------|-----------|-------------|-----------|------------|-------------|
| Audio room | 10 | 3,000 | 80% | 7.3 kBps | 23 MBps |
| Large video meeting (720p) | 150 | 150 | 85% | 50 MBps | 93 MBps |
| Video livestream (720p) | 1 | 3,000 | 92% | 233 kBps | 531 MBps |

**Extrapolated capacity for Hetzner CPX31 (4 vCPU / 7.6 GB RAM):**

| Scenario | Estimated Max Participants |
|----------|---------------------------|
| Audio-only meeting | 20-30 active speakers, ~200 listeners |
| Video meeting (720p, all cameras on) | 15-25 participants |
| Video meeting (mixed: some cameras, some audio-only) | 25-40 participants |
| Livestream (1 broadcaster, many viewers) | 1 broadcaster + ~500 viewers |
| Screen share + audio | 30-50 participants |

The key constraint: approximately 100 downstream video tracks per CPU core. With 4 cores on CPX31, that means roughly 400 downstream tracks. In a 10-person video call, each person subscribes to 9 others = 90 downstream tracks = well within budget. A 25-person video call = 600 downstream tracks = pushing limits.

**LiveKit Cloud vs Self-Hosted Tradeoffs:**

| Factor | Self-Hosted (CPX31) | LiveKit Cloud |
|--------|-------------------|---------------|
| Cost | Included in server rent (~EUR 16.49/mo) | $0.0004-0.0005/min per WebRTC participant |
| Max room capacity | ~25-40 video, ~200 audio | Unlimited (global mesh SFU) |
| Recording | Need Egress service (uses CPU) | Managed, $0.015-0.02/min |
| Latency | Single region (Hetzner EU) | Global edge network |
| Control | Full | Vendor-managed |
| Analytics | Custom/external | Built-in dashboard |
| SLA | None | 99.99% uptime |
| Maintenance | You manage upgrades, monitoring | Managed |

**Verdict:** Self-hosted LiveKit is the clear winner for Rivr's Phase 1. The existing token server integration, the Go-based SFU's efficiency on limited hardware, and the comprehensive recording/streaming ecosystem make it the strongest fit. Cloud can serve as overflow for large events.

---

#### Jitsi Meet

Jitsi is a complete, batteries-included open-source video conferencing solution.

**Pros:**
- Full-featured UI out of the box (screen share, chat, recording, hand raise, breakout rooms)
- Apache 2.0 license, no commercial cloud offering
- Large community, well-documented Docker deployment
- Fastest path to a working video conferencing product

**Cons:**
- Monolithic: hard to decompose and embed into Rivr's existing UI/UX
- Designed for standalone use, not as building blocks for a custom platform
- Performance sweet spot is 10-50 participants; drops off beyond that
- Duplicate features with Rivr (already has Matrix chat, own UI, own auth)
- No first-class recording-to-S3/MinIO pipeline (Jibri is resource-heavy)

**Verdict:** Jitsi is better suited as a standalone conferencing tool. Rivr needs composable building blocks, not another full application to embed.

---

#### Mediasoup

Mediasoup is a low-level WebRTC SFU exposed as Node.js and Rust libraries. The application is built within the same process as the SFU.

**Pros:**
- Extremely performant (C++ core, Node.js or Rust API)
- Fine-grained control over routing, codecs, transport
- Well-suited for building custom media pipelines

**Cons:**
- No recording, streaming, or room management out of the box
- Must build everything: signaling, room logic, recording pipeline, RTMP bridge
- Significant engineering effort (months of work for a small team)
- No egress/ingress equivalent; must integrate FFmpeg manually

**Verdict:** Mediasoup is for teams building a media platform from scratch. Overkill complexity for Rivr's needs when LiveKit provides the same performance with batteries included.

---

#### Pion (Go WebRTC Stack)

Pion is a pure Go implementation of WebRTC protocols.

**Pros:**
- Go-native, great for backend and IoT
- Maximum flexibility and customization
- No browser dependency

**Cons:**
- Even lower-level than mediasoup; it is a protocol library, not an SFU
- Must build SFU, signaling, recording, everything
- LiveKit is itself built on Pion; using LiveKit gives you Pion's performance with higher-level abstractions

**Verdict:** If you need a custom WebRTC protocol implementation, use Pion. For meetings and video features, use LiveKit (which wraps Pion).

---

#### Janus Gateway

Janus is a C-based WebRTC gateway server with a plugin architecture.

**Pros:**
- Mature (10+ years), battle-tested
- Plugin system: video rooms, SIP, streaming, recording
- Supports WebRTC, SIP, RTSP, RTP
- Very lightweight

**Cons:**
- C codebase, harder to extend
- Plugin APIs are dated
- No modern SDK ecosystem comparable to LiveKit
- Recording requires custom pipeline integration
- Community is smaller and less active than LiveKit's

**Verdict:** Janus is a solid choice for SIP/telephony bridging but LiveKit's modern SDK and ecosystem are better for Rivr's use cases.

---

#### 100ms

100ms is a cloud-first video SDK platform. Their UI components are open source, but the infrastructure is proprietary.

**Pros:**
- Pre-built UI kits for React, Flutter
- Strong interactivity features (polls, Q&A, virtual backgrounds)
- AI summaries and noise cancellation

**Cons:**
- Cannot self-host the SFU infrastructure
- Closed-source backend
- Premium features are expensive
- Vendor lock-in

**Verdict:** Not suitable for Rivr's self-hosted architecture.

---

### 1.2 Cloud/SaaS Options

| Provider | Free Tier | Per-Minute Rate (Video) | Recording | Max Participants | Self-Host Option |
|----------|-----------|------------------------|-----------|-----------------|-----------------|
| **LiveKit Cloud** | 5,000 WebRTC min/mo | $0.0004-0.0005/min | $0.015-0.02/min | Unlimited | Yes (open source) |
| **Daily.co** | 10,000 min/mo | $0.004/min | $0.01349/min | 1,000+ | No |
| **Twilio Video** | None (pay-as-you-go) | $0.004/min | $0.004/min | 50 (group rooms) | No |
| **Vonage** | 2,000 min/mo | $0.00395/min | $0.10/min | 250 | No |
| **Amazon Chime SDK** | None | $0.0017/user/min | $0.01-0.0125/min | 250 | No |
| **Agora** | 10,000 min/mo | $0.004-0.009/min | Separate product | 1,000+ | No |

**Cost comparison for 1,000 hours/month of video meetings (10 avg participants):**

| Provider | Monthly Cost |
|----------|-------------|
| Self-hosted LiveKit (CPX31) | $0 (included in server) |
| LiveKit Cloud (Ship tier) | ~$250 (after included minutes) |
| Daily.co | ~$2,040 |
| Twilio Video | ~$2,400 |
| Agora | ~$3,240 |
| Vonage | ~$2,133 |
| Amazon Chime SDK | ~$1,020 |

**Recommendation:** Self-hosted LiveKit for primary use. LiveKit Cloud as overflow for large events that exceed CPX31 capacity. No reason to consider other cloud providers given LiveKit's existing integration and superior pricing.

---

## 2. Meeting Rooms for Rivr Groups

### 2.1 Feature Requirements

Rivr group meetings flow from the existing live invite system:

```
Live Invite Post --> Meeting Event --> LiveKit Room --> Recording --> MinIO --> Transcript --> Group Docs
```

**Core features needed:**

| Feature | Priority | Implementation Approach |
|---------|----------|----------------------|
| Video + audio | P0 | LiveKit client SDK, `@livekit/components-react` |
| Screen sharing | P0 | LiveKit screen share track |
| Recording to MinIO | P0 | LiveKit Egress with S3-compatible output |
| Chat during meeting | P1 | Reuse existing Matrix integration |
| Live transcription | P1 | WhisperX pipeline (audio track --> WhisperX --> transcript doc) |
| Active speaker detection | P1 | LiveKit built-in (dominant speaker events) |
| Hand raising | P1 | LiveKit data channels (custom metadata) |
| Breakout rooms | P2 | Multiple LiveKit rooms + participant movement API |
| Virtual backgrounds | P3 | Client-side ML (TensorFlow.js body segmentation) |

### 2.2 LiveKit Integration Plan

#### What Already Exists

The Autobot token server at `Autobot/token-server/server.js` already:
- Imports `livekit-server-sdk` for `AccessToken` generation
- Has `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` configured
- Issues JWT tokens with room join, publish, and subscribe grants
- Currently hardcoded to `ROOM_NAME = "digital-human"` for OpenClaw

#### What Needs to Change

**1. Dynamic Room Creation**

Replace the hardcoded room name with dynamic room management. The Rivr backend needs a room management API:

```typescript
// POST /api/meetings/create
// Creates a LiveKit room and associates it with a Rivr event
interface CreateMeetingRequest {
  eventId: string;
  groupId: string;
  title: string;
  maxParticipants?: number;
  enableRecording?: boolean;
  enableTranscription?: boolean;
}

interface CreateMeetingResponse {
  meetingId: string;
  roomName: string;   // LiveKit room identifier
  joinUrl: string;
  startsAt: string;
}
```

**2. Token Server Extension**

The existing token server needs to support dynamic rooms with role-based permissions:

```typescript
// POST /api/meetings/:meetingId/token
// Issues a LiveKit JWT for a specific meeting room
interface TokenRequest {
  userId: string;
  role: 'host' | 'presenter' | 'participant' | 'viewer';
}

// Role-based grants:
// host:       canPublish, canSubscribe, canPublishData, roomAdmin
// presenter:  canPublish, canSubscribe, canPublishData
// participant: canPublish, canSubscribe, canPublishData
// viewer:     canSubscribe only
```

**3. LiveKit Server API Integration**

Use the LiveKit Server SDK (Node.js) for room management:

```typescript
import { RoomServiceClient } from 'livekit-server-sdk';

const roomService = new RoomServiceClient(
  LIVEKIT_WS_URL,
  LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET
);

// Create room
await roomService.createRoom({
  name: `rivr-meeting-${eventId}`,
  emptyTimeout: 300,        // 5 min auto-close when empty
  maxParticipants: 50,
  metadata: JSON.stringify({ eventId, groupId, title }),
});

// List participants
const participants = await roomService.listParticipants(roomName);

// Mute a participant
await roomService.mutePublishedTrack(roomName, participantIdentity, trackSid, true);

// Remove a participant
await roomService.removeParticipant(roomName, participantIdentity);
```

**4. Recording to MinIO via Egress**

Configure LiveKit Egress to write recordings to MinIO (S3-compatible):

```typescript
import { EgressClient, EncodedFileOutput } from 'livekit-server-sdk';

const egressClient = new EgressClient(LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// Start room composite recording
const egressInfo = await egressClient.startRoomCompositeEgress(roomName, {
  file: {
    fileType: 'MP4',
    filepath: `recordings/{room_name}/{time}.mp4`,
    s3: {
      accessKey: MINIO_ACCESS_KEY,
      secret: MINIO_SECRET_KEY,
      bucket: 'rivr-recordings',
      endpoint: MINIO_ENDPOINT,     // e.g., http://minio:9000
      region: 'us-east-1',          // required even for MinIO
      forcePathStyle: true,          // required for MinIO
    },
  },
});

// Stop recording
await egressClient.stopEgress(egressInfo.egressId);
```

**5. WhisperX Live Transcription Pipeline**

Two approaches for live transcription:

**Approach A: LiveKit Track Egress to WhisperX (Recommended)**

```
LiveKit Room --> Track Egress (audio) --> WebSocket --> WhisperX --> Transcript Doc
```

Use LiveKit's Track Egress to stream audio to a WebSocket endpoint running WhisperX:

```typescript
// Start audio track egress to WebSocket
await egressClient.startTrackEgress(roomName, {
  websocketUrl: 'ws://whisperx-service:8765/transcribe',
  trackSid: audioTrackSid,
});
```

The WhisperX service receives raw audio frames, runs inference, and pushes transcript segments back to Rivr via API or Matrix room.

**Approach B: WhisperLiveKit (Direct Integration)**

WhisperLiveKit is a 2025 open-source project that provides native LiveKit integration for real-time STT with speaker diarization. It uses SimulStreaming (SOTA 2025) and Streaming Sortformer (SOTA 2025) for diarization. This could be deployed as a LiveKit Agent that automatically joins rooms and transcribes.

**6. Frontend: React Components**

Use `@livekit/components-react` for the meeting UI:

```tsx
import {
  LiveKitRoom,
  VideoConference,
  GridLayout,
  ParticipantTile,
  ControlBar,
  RoomAudioRenderer,
  useTracks,
} from '@livekit/components-react';
import '@livekit/components-styles';

export function MeetingRoom({ token, serverUrl }: Props) {
  return (
    <LiveKitRoom
      token={token}
      serverUrl={serverUrl}
      connect={true}
      video={true}
      audio={true}
    >
      <VideoConference />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}
```

The `<VideoConference />` component includes:
- Participant grid with active speaker highlighting
- Camera/microphone toggle controls
- Screen sharing button
- Settings menu (device selection)
- Participant list
- Chat panel

### 2.3 Meeting Flow in Rivr

```
1. Group member creates a Live Invite post in group feed
   --> Rivr backend creates Meeting record in DB
   --> Rivr backend creates LiveKit room via RoomServiceClient

2. Members RSVP to the live invite
   --> RSVP stored in events table

3. At meeting time, members click "Join Meeting"
   --> Rivr backend generates LiveKit JWT token (role-based)
   --> Client connects to LiveKit room via @livekit/components-react
   --> If recording enabled: Egress starts recording to MinIO
   --> If transcription enabled: Audio track egressed to WhisperX

4. During meeting:
   --> Video/audio/screen share via LiveKit WebRTC
   --> Chat via existing Matrix room (linked to group)
   --> Transcript segments accumulate in real-time

5. Meeting ends:
   --> LiveKit room closes
   --> Recording finalized in MinIO (MP4)
   --> WhisperX produces final transcript
   --> Transcript saved as Group Doc (linked to event)
   --> Recording URL stored in Group Resources
   --> Notification sent to group members
```

---

## 3. Training / Webinar Mode

### 3.1 Feature Design

Training mode extends the base meeting room with structured controls for educational settings.

**Host/Presenter Controls:**

| Control | Implementation |
|---------|---------------|
| Mute all participants | `roomService.mutePublishedTrack()` on all participants |
| Spotlight a speaker | Custom UI: pin participant to main view via data channel message |
| Lock room | `roomService.updateRoom()` with `maxParticipants: currentCount` |
| Enable/disable participant video | Permission grants via token (reissue with `canPublish: false`) |
| Screen share priority | Only host can share unless permission granted |
| Kick participant | `roomService.removeParticipant()` |

**Attendee Interactions:**

| Feature | Implementation |
|---------|---------------|
| Hand raise queue | LiveKit data channels: participant sends `{ type: 'hand_raise' }`, host UI shows ordered queue |
| Polls | Data channel messages: host broadcasts poll, participants respond, results aggregated |
| Q&A panel | Data channel or Matrix room: questions submitted, host can promote to live |
| Emoji reactions | Data channel: lightweight reaction events displayed as overlays |

**Breakout Rooms:**

LiveKit natively supports breakout rooms through its multi-room architecture:

```typescript
// Host creates breakout rooms
const breakoutRooms = await Promise.all(
  groups.map((group, i) =>
    roomService.createRoom({
      name: `${mainRoomName}-breakout-${i}`,
      emptyTimeout: 600,
      maxParticipants: group.length,
      metadata: JSON.stringify({ parentRoom: mainRoomName, groupIndex: i }),
    })
  )
);

// Move participant to breakout room
// 1. Issue new token for breakout room
// 2. Client disconnects from main room, connects to breakout
// 3. When done, reverse the process
```

**Recording with Chapter Markers:**

```typescript
// During training, host can add chapter markers
// Stored as timestamped events in meeting metadata
const chapters = [
  { time: 0, title: 'Introduction' },
  { time: 1200, title: 'Module 1: Basics' },
  { time: 2400, title: 'Module 2: Advanced Topics' },
  { time: 3600, title: 'Q&A Session' },
];

// Post-session: chapters + recording + transcript + slides
// assembled into a training document in Group Docs
```

### 3.2 Post-Session Training Materials

After a training session ends, Rivr automatically assembles:

1. **Recording** (MP4 in MinIO) with chapter index
2. **Transcript** (from WhisperX) with speaker labels and timestamps
3. **Slides/Screen Captures** (if screen was shared, periodic screenshots via Egress image output)
4. **Poll Results** summary
5. **Q&A Log** from data channel or Matrix

All stored as a Training Document in Group Docs, browsable with a custom player component that syncs video playback with transcript highlights and chapter navigation.

---

## 4. Livestreaming

### 4.1 WebRTC to RTMP Bridge

LiveKit Egress provides native RTMP output for streaming to external platforms.

**Supported Targets:**

| Platform | RTMP URL Format |
|----------|----------------|
| YouTube Live | `rtmp://a.rtmp.youtube.com/live2/{stream_key}` |
| Twitch | `rtmp://live.twitch.tv/app/{stream_key}` |
| Facebook Live | `rtmps://live-api-s.facebook.com:443/rtmp/{stream_key}` |
| Custom HLS | LiveKit Egress HLS segment output to MinIO/nginx |

**Simulcast to Multiple Platforms:**

LiveKit Egress can stream to multiple RTMP endpoints simultaneously from a single egress job:

```typescript
const egressInfo = await egressClient.startRoomCompositeEgress(roomName, {
  stream: {
    protocol: 'RTMP',
    urls: [
      `rtmp://a.rtmp.youtube.com/live2/${youtubeKey}`,
      `rtmp://live.twitch.tv/app/${twitchKey}`,
    ],
  },
});

// Can also add/remove streams dynamically
await egressClient.updateStream(egressInfo.egressId, {
  addOutputUrls: [`rtmp://custom-server/live/${streamKey}`],
});
```

**Important caveat from LiveKit docs:** "RTMP streams do not perform well over long distances." Since the Hetzner servers are in Europe, streaming to US-based RTMP endpoints (YouTube, Twitch) may have quality issues. Mitigation: use LiveKit Cloud Egress for RTMP output to benefit from their global network, or use a closer relay.

### 4.2 Self-Hosted HLS Streaming

For Rivr's own livestreaming (no dependency on YouTube/Twitch), use LiveKit Egress to produce HLS segments:

```typescript
// Start HLS egress
const egressInfo = await egressClient.startRoomCompositeEgress(roomName, {
  segments: {
    filenamePrefix: `livestream/${roomName}/segment`,
    playlistName: 'index.m3u8',
    segmentDuration: 6,
    s3: {
      accessKey: MINIO_ACCESS_KEY,
      secret: MINIO_SECRET_KEY,
      bucket: 'rivr-livestreams',
      endpoint: MINIO_ENDPOINT,
      forcePathStyle: true,
    },
  },
});
```

**HLS Viewer Architecture:**

```
LiveKit Room (host) --> Egress --> HLS segments --> MinIO bucket
                                                      |
                                              nginx reverse proxy
                                                      |
                                              HLS.js player in Rivr
                                                      |
                                              Viewer page (unlimited audience)
```

The HLS viewer page serves as a scalable read-only audience endpoint. HLS adds 6-15 seconds of latency (depending on segment duration) but scales to unlimited viewers since it is just static file serving from MinIO/nginx.

**Latency Tradeoffs:**

| Method | Latency | Audience Scale | Interactivity |
|--------|---------|---------------|---------------|
| WebRTC (LiveKit room) | <500ms | Limited by SFU (~500 on CPX31) | Full (bidirectional) |
| WebRTC + HLS hybrid | WebRTC: <500ms, HLS: 6-15s | WebRTC panel + unlimited HLS | Panel interactive, HLS view-only |
| HLS only | 6-15s | Unlimited | View-only + chat |
| RTMP to platform | 3-10s | Platform-dependent (millions) | Platform chat |

**Recommended approach for Rivr:** Hybrid model. Active participants (presenters, panelists) connect via WebRTC. Large audiences view via HLS served from MinIO. Chat overlay pulled from the linked Matrix room.

### 4.3 Livestream Chat Overlay

Since Rivr already has Matrix integration, livestream chat is straightforward:

- Each livestream event has a linked Matrix room
- Chat messages from the Matrix room are displayed as a chat overlay on the HLS viewer page
- Viewers can send messages via the Rivr UI, which routes through Matrix
- Moderators can moderate from the same Matrix room interface

### 4.4 LiveKit Ingress for External Broadcasters

For users who want to broadcast using OBS Studio or other RTMP-capable software:

```
OBS Studio --> RTMP --> LiveKit Ingress (port 1935) --> LiveKit Room --> Viewers
```

LiveKit Ingress validates the incoming RTMP stream and transcodes it to WebRTC for LiveKit room participants. Configuration:

```yaml
# ingress.yaml
api_key: your-api-key
api_secret: your-api-secret
ws_url: wss://livekit.your-domain.com
rtmp_port: 1935
whip_port: 8080
redis:
  address: redis:6379
```

The Rivr UI generates a unique RTMP URL and stream key for each livestream event, which the broadcaster enters in OBS.

---

## 5. Video Posts and Reels

### 5.1 Recording

**In-Browser Video Recording:**

Use the MediaRecorder API for capturing video directly in the Rivr web app:

```typescript
// Camera recording
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1080, height: 1920 }, // 9:16 for reels
  audio: true,
});

const recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm;codecs=vp9',
  videoBitsPerSecond: 5_000_000,
});

const chunks: Blob[] = [];
recorder.ondataavailable = (e) => chunks.push(e.data);
recorder.onstop = () => {
  const blob = new Blob(chunks, { type: 'video/webm' });
  uploadToMinIO(blob);
};

recorder.start(1000); // 1-second chunks for progress feedback
```

**Screen Recording:**

```typescript
const screenStream = await navigator.mediaDevices.getDisplayMedia({
  video: { width: 1920, height: 1080 },
  audio: true,
});
// Same MediaRecorder pipeline as above
```

**File Upload:**

Standard file upload to MinIO for pre-recorded videos. Support formats: MP4, WebM, MOV, AVI. Maximum file size depends on MinIO configuration (recommended: 2 GB for long-form, 100 MB for reels).

### 5.2 Processing Pipeline

```
Upload/Record --> MinIO (raw/) --> Transcode Queue --> FFmpeg Worker --> MinIO (processed/)
                                       |
                                  WhisperX Worker
                                       |
                                  Transcript + Captions
```

**FFmpeg Transcoding Worker:**

A Docker container that watches a job queue (Redis or PostgreSQL) and processes videos:

```dockerfile
FROM jrottenberg/ffmpeg:5-ubuntu

RUN apt-get update && apt-get install -y python3 python3-pip
RUN pip3 install minio redis

COPY transcode-worker.py /app/
CMD ["python3", "/app/transcode-worker.py"]
```

**Transcoding profiles:**

```bash
# 1080p (source quality)
ffmpeg -i input.mp4 \
  -c:v libx264 -preset medium -crf 23 -maxrate 5000k -bufsize 10000k \
  -c:a aac -b:a 128k -ar 44100 \
  -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2" \
  -hls_time 6 -hls_playlist_type vod -hls_segment_filename "1080p_%03d.ts" \
  1080p.m3u8

# 720p
ffmpeg -i input.mp4 \
  -c:v libx264 -preset medium -crf 23 -maxrate 2500k -bufsize 5000k \
  -c:a aac -b:a 96k -ar 44100 \
  -vf "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2" \
  -hls_time 6 -hls_playlist_type vod -hls_segment_filename "720p_%03d.ts" \
  720p.m3u8

# 480p
ffmpeg -i input.mp4 \
  -c:v libx264 -preset medium -crf 23 -maxrate 1000k -bufsize 2000k \
  -c:a aac -b:a 64k -ar 44100 \
  -vf "scale=854:480:force_original_aspect_ratio=decrease,pad=854:480:(ow-iw)/2:(oh-ih)/2" \
  -hls_time 6 -hls_playlist_type vod -hls_segment_filename "480p_%03d.ts" \
  480p.m3u8

# Master playlist (adaptive)
cat > master.m3u8 << 'EOF'
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
1080p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480
480p.m3u8
EOF

# Thumbnail generation (at 2 seconds)
ffmpeg -i input.mp4 -ss 2 -vframes 1 -vf "scale=640:360" thumbnail.jpg

# Animated preview (first 3 seconds, 10fps, 320px wide)
ffmpeg -i input.mp4 -ss 0 -t 3 -vf "fps=10,scale=320:-1:flags=lanczos" -loop 0 preview.webp
```

**Auto-captioning via WhisperX:**

```bash
# Extract audio
ffmpeg -i input.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.wav

# WhisperX transcription (produces word-level timestamps + speaker diarization)
whisperx audio.wav --model large-v3 --output_format vtt --diarize

# Output: audio.vtt (WebVTT subtitle file)
```

The VTT file is stored alongside the video in MinIO and served as a subtitle track.

### 5.3 Reels / Short-Form Video

**Format Specifications:**

| Property | Value |
|----------|-------|
| Aspect ratio | 9:16 (vertical) |
| Resolution | 1080x1920 (max) |
| Duration | 15s - 90s |
| File format | HLS (transcoded) |
| Thumbnail | 640x1136 JPEG |

**Feed Implementation:**

The reels feed uses a vertical scroll (snap-scroll) pattern:

```tsx
// Vertical scroll container with snap points
export function ReelsFeed({ reels }: { reels: Reel[] }) {
  return (
    <div className="h-screen overflow-y-scroll snap-y snap-mandatory">
      {reels.map((reel) => (
        <div key={reel.id} className="h-screen snap-start">
          <ReelPlayer reel={reel} />
        </div>
      ))}
    </div>
  );
}

// Individual reel player with HLS.js
export function ReelPlayer({ reel }: { reel: Reel }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(reel.hlsUrl);
      hls.attachMedia(videoRef.current);
    } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
      videoRef.current.src = reel.hlsUrl; // Safari native HLS
    }
  }, [reel.hlsUrl]);

  return (
    <div className="relative h-full w-full bg-black">
      <video
        ref={videoRef}
        className="h-full w-full object-cover"
        autoPlay
        muted
        loop
        playsInline
      />
      {/* Overlay controls */}
      <ReelOverlay reel={reel} videoRef={videoRef} />
    </div>
  );
}
```

**Reel interactions reuse existing Rivr primitives:**

| Interaction | Rivr Integration |
|-------------|-----------------|
| Like | Existing post like system |
| Comment | Existing post comment system |
| Share | Existing post share system |
| Group-scoped | Filter by group membership |
| Discover | Cross-group discovery feed |

### 5.4 Video Player Component

A full-featured video player for long-form content:

```tsx
import Hls from 'hls.js';

export function VideoPlayer({ src, subtitles, chapters }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [quality, setQuality] = useState<number>(-1); // auto

  useEffect(() => {
    if (!videoRef.current || !Hls.isSupported()) return;

    const hls = new Hls({
      startLevel: -1, // auto quality
      capLevelToPlayerSize: true,
    });

    hls.loadSource(src);
    hls.attachMedia(videoRef.current);

    return () => hls.destroy();
  }, [src]);

  return (
    <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
      <video
        ref={videoRef}
        className="w-full h-full"
        controls
        playsInline
      >
        {subtitles && (
          <track
            kind="subtitles"
            src={subtitles}
            srcLang="en"
            label="English"
            default
          />
        )}
      </video>
    </div>
  );
}
```

**Player features:**

| Feature | Implementation |
|---------|---------------|
| Adaptive streaming | HLS.js with `capLevelToPlayerSize` |
| Subtitles/captions | WebVTT track from WhisperX output |
| Playback speed | `<video>.playbackRate` (0.5x, 1x, 1.25x, 1.5x, 2x) |
| Picture-in-picture | `<video>.requestPictureInPicture()` |
| Fullscreen | Fullscreen API |
| Share with timestamp | URL parameter `?t=123` + `<video>.currentTime` |
| Chapter navigation | Custom UI reading chapter metadata |
| Quality selector | HLS.js `hls.levels` + `hls.currentLevel` |

---

## 6. Architecture: How It All Connects

### 6.1 System Flows

```
MEETING FLOW
============
Live Invite Post
  --> Rivr Backend creates Meeting record
  --> Rivr Backend calls LiveKit RoomServiceClient.createRoom()
  --> Members RSVP
  --> At meeting time: Rivr Backend issues LiveKit JWT tokens
  --> Clients connect via @livekit/components-react
  --> If recording: EgressClient.startRoomCompositeEgress() --> MinIO
  --> If transcription: Track Egress audio --> WhisperX service
  --> Meeting ends: Recording finalized in MinIO
  --> WhisperX produces final transcript
  --> Transcript saved as Group Doc
  --> Recording URL stored in Group Resources


LIVESTREAM FLOW
===============
Livestream Event Created
  --> LiveKit Room created
  --> Host joins via WebRTC (camera/screen share)
  --> Egress starts:
      - RTMP output to YouTube/Twitch (simultaneous)
      - HLS segments to MinIO (for self-hosted viewer page)
  --> Viewers:
      - Small panel (co-hosts): WebRTC via LiveKit
      - Large audience: HLS viewer page on Rivr
      - External: YouTube/Twitch embedded players
  --> Chat: Matrix room overlay on all viewer surfaces
  --> Recording: saved to MinIO on stream end
  --> Transcript: WhisperX processes audio track


VIDEO POST FLOW
===============
User records or uploads video
  --> Raw file stored in MinIO (raw/ prefix)
  --> Job queued in Redis/PostgreSQL
  --> FFmpeg Worker picks up job:
      - Transcode to 1080p/720p/480p HLS
      - Generate thumbnail
      - Generate animated preview
  --> WhisperX Worker:
      - Extract audio
      - Generate VTT subtitles
  --> Processed HLS + thumbnails stored in MinIO (processed/ prefix)
  --> Post created in Rivr feed with video attachment
  --> HLS.js player renders in feed


REEL FLOW
=========
User records vertical video (9:16)
  --> Same pipeline as Video Post, but:
      - Enforced 9:16 aspect ratio
      - Duration cap: 15-90 seconds
      - Optimized for mobile playback
  --> Appears in vertical-scroll Reels feed
  --> Group-scoped: appears in group Reels tab
  --> Discovery: appears in cross-group Discover feed


TRANSCRIPTION (ALL FLOWS)
=========================
Audio source (meeting/livestream/video)
  --> WhisperX service (Docker container on PM Core or Camalot)
  --> Output: timestamped transcript with speaker diarization
  --> Saved as:
      - Group Doc (for meetings)
      - VTT subtitle file (for videos)
      - Searchable text index (for discovery)
```

### 6.2 Data Model Additions

```sql
-- Meeting rooms
CREATE TABLE meetings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id),
  group_id UUID REFERENCES groups(id),
  livekit_room_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled, live, ended
  recording_enabled BOOLEAN DEFAULT false,
  transcription_enabled BOOLEAN DEFAULT false,
  recording_url TEXT,
  transcript_doc_id UUID REFERENCES documents(id),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  max_participants INTEGER DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Video content
CREATE TABLE videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  group_id UUID REFERENCES groups(id),
  post_id UUID REFERENCES posts(id),
  title TEXT,
  description TEXT,
  type TEXT NOT NULL DEFAULT 'video', -- video, reel, recording, livestream_vod
  status TEXT NOT NULL DEFAULT 'processing', -- processing, ready, failed
  raw_url TEXT NOT NULL,          -- MinIO raw file URL
  hls_url TEXT,                   -- MinIO HLS manifest URL
  thumbnail_url TEXT,
  preview_url TEXT,               -- Animated preview
  subtitle_url TEXT,              -- VTT from WhisperX
  duration_seconds INTEGER,
  width INTEGER,
  height INTEGER,
  aspect_ratio TEXT,              -- '16:9', '9:16', '1:1'
  file_size_bytes BIGINT,
  transcoded_size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Transcode jobs queue
CREATE TABLE transcode_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID REFERENCES videos(id),
  status TEXT NOT NULL DEFAULT 'queued', -- queued, processing, completed, failed
  profiles TEXT[] DEFAULT ARRAY['1080p', '720p', '480p'],
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Livestream sessions
CREATE TABLE livestreams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id),
  group_id UUID REFERENCES groups(id),
  meeting_id UUID REFERENCES meetings(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled, live, ended
  hls_url TEXT,                     -- Self-hosted HLS viewer URL
  rtmp_targets JSONB DEFAULT '[]',  -- [{platform, url, key}]
  viewer_count INTEGER DEFAULT 0,
  peak_viewer_count INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  vod_video_id UUID REFERENCES videos(id), -- Post-stream VOD
  created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 7. PM Core Docker Services Needed

### 7.1 Docker Compose Service Definitions

The following services should be added to the PM Core Docker Compose configuration on the Camalot host (5.161.46.237) or the Rivr Social host (178.156.185.116), depending on where meetings traffic should live.

**Recommended deployment:** Camalot host for media services (LiveKit, Egress, FFmpeg worker) since it can be dedicated to media processing. Rivr Social host stays focused on the web application.

```yaml
# docker-compose.livekit.yaml
# Media services for Rivr meetings, streaming, and video

version: '3.8'

services:
  # ===========================================
  # LiveKit SFU Server
  # ===========================================
  livekit-server:
    image: livekit/livekit-server:v1.8
    container_name: pmdl_livekit_server
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config/livekit.yaml:/etc/livekit.yaml:ro
    command: --config /etc/livekit.yaml
    depends_on:
      - redis-livekit
    # Ports used (host networking):
    # 7880 - HTTP API + WebSocket signaling
    # 7881 - ICE over TCP
    # 3478 - TURN/UDP
    # 50000-60000 - WebRTC media (UDP)

  # ===========================================
  # Redis (LiveKit message bus)
  # ===========================================
  redis-livekit:
    image: redis:7-alpine
    container_name: pmdl_redis_livekit
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config/redis-livekit.conf:/etc/redis/redis.conf:ro
      - livekit-redis-data:/data
    command: redis-server /etc/redis/redis.conf

  # ===========================================
  # LiveKit Egress (recording + streaming)
  # ===========================================
  livekit-egress:
    image: livekit/egress:v1.8
    container_name: pmdl_livekit_egress
    restart: unless-stopped
    cap_add:
      - SYS_ADMIN  # Required since v1.7.6 for Chrome sandboxing
    environment:
      - EGRESS_CONFIG_BODY=${EGRESS_CONFIG}
    volumes:
      - ./config/egress.yaml:/etc/egress.yaml:ro
      - egress-tmp:/tmp/egress
    deploy:
      resources:
        limits:
          cpus: '3'
          memory: 4G
        reservations:
          cpus: '2'
          memory: 2G
    # Note: Egress uses significant CPU for RoomComposite (Chrome rendering)
    # On CPX31, limit to 1 concurrent RoomComposite egress

  # ===========================================
  # LiveKit Ingress (RTMP/WHIP ingest)
  # ===========================================
  livekit-ingress:
    image: livekit/ingress:v1.4
    container_name: pmdl_livekit_ingress
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config/ingress.yaml:/etc/ingress.yaml:ro
    environment:
      - INGRESS_CONFIG_FILE=/etc/ingress.yaml
    # Ports used (host networking):
    # 1935 - RTMP ingest
    # 8080 - WHIP ingest
    # 7885 - ICE for WHIP (UDP)

  # ===========================================
  # FFmpeg Transcoding Worker
  # ===========================================
  ffmpeg-worker:
    build:
      context: ./services/ffmpeg-worker
      dockerfile: Dockerfile
    container_name: pmdl_ffmpeg_worker
    restart: unless-stopped
    environment:
      - MINIO_ENDPOINT=http://minio:9000
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
      - MINIO_BUCKET_RAW=rivr-raw
      - MINIO_BUCKET_PROCESSED=rivr-processed
      - REDIS_URL=redis://redis-livekit:6379/1
      - WHISPERX_URL=http://whisperx:9090
      - MAX_CONCURRENT_JOBS=1
    volumes:
      - transcode-tmp:/tmp/transcode
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G

  # ===========================================
  # Caddy Reverse Proxy (TLS termination)
  # ===========================================
  caddy-livekit:
    image: caddy:2
    container_name: pmdl_caddy_livekit
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./config/caddy-livekit.yaml:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config

volumes:
  livekit-redis-data:
  egress-tmp:
  transcode-tmp:
  caddy-data:
  caddy-config:
```

### 7.2 Configuration Files

**livekit.yaml:**

```yaml
port: 7880
bind_addresses:
  - ""
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
  enable_loopback_candidate: false

redis:
  address: localhost:6379

keys:
  # Production key pair (generate with: openssl rand -hex 32)
  rivr_api_key: <GENERATED_SECRET>

room:
  auto_create: false
  empty_timeout: 300
  max_participants: 50

turn:
  enabled: true
  domain: turn.rivr.social
  tls_port: 5349
  udp_port: 3478

webhook:
  urls:
    - https://api.rivr.social/webhooks/livekit
  api_key: rivr_api_key

logging:
  level: info
  pion_level: warn

egress:
  # Auto-egress configuration (optional)
  # room_composite:
  #   file_outputs:
  #     - file_type: mp4
  #       s3:
  #         access_key: <MINIO_KEY>
  #         secret: <MINIO_SECRET>
  #         bucket: rivr-recordings
  #         endpoint: http://minio:9000
  #         force_path_style: true
```

**egress.yaml:**

```yaml
api_key: rivr_api_key
api_secret: <GENERATED_SECRET>
ws_url: wss://livekit.rivr.social

log_level: info
health_port: 7970

# S3-compatible storage (MinIO)
s3:
  access_key: <MINIO_ACCESS_KEY>
  secret: <MINIO_SECRET_KEY>
  bucket: rivr-recordings
  endpoint: http://minio:9000
  region: us-east-1
  force_path_style: true

redis:
  address: localhost:6379

# Resource limits for CPX31
# RoomComposite uses ~2-6 CPUs
# Limit concurrent egress jobs
# template_port: 7980
```

**ingress.yaml:**

```yaml
api_key: rivr_api_key
api_secret: <GENERATED_SECRET>
ws_url: wss://livekit.rivr.social

rtmp_port: 1935
whip_port: 8080

logging:
  level: info

redis:
  address: localhost:6379
```

**redis-livekit.conf:**

```conf
bind 127.0.0.1
port 6379
maxmemory 256mb
maxmemory-policy allkeys-lru
save ""
appendonly no
```

### 7.3 Resource Requirements Summary

**Camalot Host (5.161.46.237) -- CPX31: 4 vCPU, 7.6 GB RAM**

| Service | CPU (typical) | CPU (peak) | RAM (typical) | RAM (peak) |
|---------|-------------|-----------|--------------|-----------|
| LiveKit Server | 0.5 core | 2 cores | 256 MB | 1 GB |
| Redis | 0.1 core | 0.2 core | 128 MB | 256 MB |
| LiveKit Egress | 0 (idle) | 3 cores (recording) | 256 MB | 3 GB |
| LiveKit Ingress | 0 (idle) | 2 cores (transcoding) | 128 MB | 2 GB |
| FFmpeg Worker | 0 (idle) | 2 cores (transcoding) | 128 MB | 2 GB |
| Caddy | 0.05 core | 0.1 core | 64 MB | 128 MB |
| **Total (idle)** | **~0.75 core** | -- | **~960 MB** | -- |
| **Total (active meeting + recording)** | -- | **~4 cores** | -- | **~5.5 GB** |

**Critical constraint:** On a CPX31, you cannot simultaneously run a meeting with recording AND a separate video transcode job. The services must be prioritized:

1. LiveKit Server always runs (meetings take priority)
2. Egress recording runs during active meetings
3. FFmpeg transcoding runs during off-peak hours or when no meetings are active
4. Ingress starts only when a livestream is scheduled

**Upgrade path:** If Rivr needs concurrent meetings + recording + transcoding, upgrade to:
- **CPX41** (8 vCPU, 16 GB RAM, ~EUR 27/mo) -- comfortable headroom
- **CPX51** (16 vCPU, 32 GB RAM, ~EUR 55/mo) -- matches LiveKit benchmark hardware
- **Split architecture:** LiveKit Server on one host, Egress/FFmpeg on another

---

## 8. Cost Analysis

### 8.1 Self-Hosted Costs

**Current infrastructure cost (no changes needed for basic meetings):**

| Item | Monthly Cost |
|------|-------------|
| Camalot CPX31 | ~EUR 16.49 |
| Rivr Social CPX31 | ~EUR 16.49 |
| Domain/DNS | ~EUR 1-2 |
| **Total** | **~EUR 35/mo** |

**Storage costs (MinIO, self-hosted):**

| Content Type | Avg Size | Storage/1000 items | Monthly @ 1000 items |
|-------------|----------|-------------------|---------------------|
| Meeting recording (1 hr, 720p) | 500 MB | 500 GB | Disk cost only |
| Video post (5 min, transcoded) | 200 MB | 200 GB | Disk cost only |
| Reel (30s, transcoded) | 20 MB | 20 GB | Disk cost only |
| Livestream VOD (2 hr) | 2 GB | 2 TB | Disk cost only |

CPX31 comes with 160 GB SSD. Video storage will need external block storage:
- Hetzner Volumes: EUR 0.052/GB/mo
- 1 TB volume: ~EUR 52/mo
- 5 TB volume: ~EUR 260/mo

**Estimated monthly cost for moderate usage (50 meetings/mo, 200 videos, 500 reels):**

| Item | Cost |
|------|------|
| Server (CPX31 x2) | EUR 33 |
| Storage volume (500 GB) | EUR 26 |
| Bandwidth (5 TB included) | EUR 0 |
| **Total** | **~EUR 59/mo** |

### 8.2 LiveKit Cloud Costs (for comparison or overflow)

**Ship tier ($50/mo base):**

| Metric | Included | Overage Rate |
|--------|----------|-------------|
| WebRTC minutes | 150,000 | $0.0005/min |
| Agent session minutes | 5,000 | $0.01/min |
| Recording/Egress (video) | 600 min | $0.02/min |
| Recording/Egress (audio) | 600 min | $0.005/min |
| Data transfer | 250 GB | $0.12/GB |

**Estimated monthly cost for same usage (50 meetings x 10 participants x 60 min):**

| Item | Calculation | Cost |
|------|------------|------|
| Base plan | -- | $50 |
| WebRTC minutes | 30,000 min (50 mtg x 10 ppl x 60 min) | $0 (within 150k included) |
| Recording | 50 hours = 3,000 min | $48 (2,400 overage x $0.02) |
| Data transfer | ~200 GB | $0 (within 250 GB) |
| **Total** | -- | **~$98/mo** |

For light usage, LiveKit Cloud is competitive. For heavy usage, self-hosted wins decisively.

### 8.3 Transcoding Costs

FFmpeg transcoding CPU time estimates:

| Content | Duration | Transcode Time (CPX31) | CPU Cost |
|---------|----------|----------------------|---------|
| 5-min video (3 profiles) | 5 min | ~8 min | Free (self-hosted) |
| 30-sec reel (3 profiles) | 30 sec | ~1 min | Free (self-hosted) |
| 1-hr meeting recording (3 profiles) | 60 min | ~90 min | Free (self-hosted) |

Key concern: transcoding a 1-hour recording takes ~90 minutes of CPU time at near-full utilization. Queue management is essential to avoid starving the LiveKit server.

### 8.4 When to Upgrade

**Stay on CPX31 if:**
- Fewer than 5 concurrent meetings
- Fewer than 50 video uploads per day
- No simultaneous recording + transcoding needed
- Meetings are under 25 participants

**Upgrade to CPX41 (8 vCPU, 16 GB) when:**
- Regular concurrent meetings
- Video processing queue exceeds 2-hour backlog
- Need simultaneous recording + transcoding
- Meetings regularly exceed 25 participants

**Upgrade to CPX51 (16 vCPU, 32 GB) or split architecture when:**
- 10+ concurrent meetings
- Heavy livestreaming (multiple simultaneous streams)
- Video processing SLA under 30 minutes
- 50+ participant meetings regularly

---

## 9. Rivr Integration Points

### 9.1 Mapping to Existing Rivr Features

| Rivr Feature | Video Integration |
|-------------|-------------------|
| **Live Invite Posts** | Create meeting room. "Join Meeting" button appears at scheduled time. |
| **Events** | Events can be type: `meeting`, `training`, `livestream`. Each type gets appropriate UI. |
| **Group Docs** | Meeting recordings and transcripts auto-create Group Docs. Transcript is searchable. |
| **Feed** | Video posts and reels appear in feed with inline HLS player. |
| **Resources Table** | Videos stored as resource type: `video`. Recordings linked to their meeting event. |
| **Marketplace** | Paid trainings/webinars: ticket purchase required before receiving LiveKit join token. |
| **Matrix Chat** | Reuse for meeting chat, livestream chat overlay, video comments. |
| **WhisperX** | Powers live transcription during meetings and auto-captioning for video posts. |
| **MinIO** | Stores all media: raw uploads, transcoded HLS, recordings, thumbnails. |
| **MCP Tools (Autobot)** | Agent can schedule meetings, start/stop recordings, manage rooms via LiveKit Server SDK. |

### 9.2 API Endpoints Needed

```
POST   /api/meetings                    Create meeting room
GET    /api/meetings/:id                Get meeting details
POST   /api/meetings/:id/token          Get join token
POST   /api/meetings/:id/start          Start meeting (host only)
POST   /api/meetings/:id/end            End meeting (host only)
POST   /api/meetings/:id/recording      Start/stop recording
GET    /api/meetings/:id/participants    List participants
POST   /api/meetings/:id/mute           Mute participant (host)
POST   /api/meetings/:id/kick           Remove participant (host)

POST   /api/livestreams                 Create livestream
POST   /api/livestreams/:id/start       Start streaming
POST   /api/livestreams/:id/stop        Stop streaming
GET    /api/livestreams/:id/viewer       Get HLS viewer URL
POST   /api/livestreams/:id/rtmp        Add/remove RTMP target

POST   /api/videos/upload               Upload video (returns presigned MinIO URL)
POST   /api/videos/record               Upload from in-browser recording
GET    /api/videos/:id                  Get video details + HLS URL
GET    /api/videos/:id/subtitles        Get VTT subtitle file
DELETE /api/videos/:id                  Delete video + all transcoded files

GET    /api/reels                       Get reels feed (paginated)
GET    /api/groups/:id/reels            Get group reels feed

POST   /webhooks/livekit               LiveKit webhook receiver (room events)
```

### 9.3 LiveKit Webhook Integration

LiveKit sends webhooks for room events. Rivr should handle:

```typescript
// POST /webhooks/livekit
// LiveKit sends events for room lifecycle

interface LiveKitWebhook {
  event: string;
  room?: RoomInfo;
  participant?: ParticipantInfo;
  egressInfo?: EgressInfo;
  ingressInfo?: IngressInfo;
}

// Events to handle:
// room_started      -> Update meeting status to 'live'
// room_finished     -> Update meeting status to 'ended', finalize transcript
// participant_joined -> Update participant count, notify group
// participant_left   -> Update participant count
// egress_started    -> Update recording status
// egress_ended      -> Store recording URL, trigger transcription
// ingress_started   -> Update livestream status
// ingress_ended     -> Update livestream status
```

### 9.4 Autobot MCP Tools

Extend the Autobot agent with meeting management capabilities:

```typescript
// MCP tool definitions for Autobot
const meetingTools = {
  schedule_meeting: {
    description: 'Schedule a meeting for a Rivr group',
    parameters: { groupId, title, startTime, duration, enableRecording },
  },
  list_active_meetings: {
    description: 'List all currently active meetings',
    parameters: {},
  },
  get_meeting_transcript: {
    description: 'Get the transcript of a completed meeting',
    parameters: { meetingId },
  },
  start_livestream: {
    description: 'Start a livestream for a group event',
    parameters: { eventId, rtmpTargets },
  },
  process_video: {
    description: 'Trigger video processing for a uploaded file',
    parameters: { videoId, profiles },
  },
};
```

---

## 10. MVP Recommendation

### Phase 1: LiveKit Meeting Rooms
**Timeline: 3-4 weeks | Dependencies: None | Hardware: Current CPX31**

Scope:
- Deploy LiveKit Server + Redis on Camalot host (Docker Compose)
- Extend existing token server for dynamic room creation
- Build meeting room UI with `@livekit/components-react`
- Integrate with Rivr's live invite and event flow
- Video + audio + screen sharing
- Participant list with mute/kick controls for host
- Active speaker detection (built into LiveKit components)

Deliverables:
- `docker-compose.livekit.yaml` with LiveKit Server + Redis
- `/api/meetings/*` endpoints in Rivr backend
- `<MeetingRoom />` component in Rivr frontend
- LiveKit webhook handler for room lifecycle events
- Updated live invite flow: "Join Meeting" button

Effort: ~120 engineering hours

---

### Phase 2: Recording + Live Transcription
**Timeline: 2-3 weeks | Dependencies: Phase 1 | Hardware: Current CPX31 (tight) or CPX41**

Scope:
- Deploy LiveKit Egress service
- Configure MinIO as S3-compatible storage target
- Recording start/stop controls in meeting UI
- Deploy WhisperX as Docker service (or reuse existing)
- Audio track egress to WhisperX for live transcription
- Transcript segments displayed in real-time during meeting
- Post-meeting: finalized transcript saved as Group Doc

Deliverables:
- Egress service in Docker Compose
- MinIO bucket configuration for recordings
- WhisperX integration (Track Egress -> WebSocket -> WhisperX)
- Recording controls in meeting UI
- Live transcript panel component
- Post-meeting transcript doc creation

Effort: ~100 engineering hours

Hardware note: Egress requires 4 CPU and 4 GB RAM for RoomComposite recording. On CPX31, this consumes nearly all resources. Recommend upgrading to CPX41 (EUR 27/mo) before deploying Egress in production.

---

### Phase 3: Video Posts
**Timeline: 3-4 weeks | Dependencies: MinIO (Phase 2) | Hardware: CPX41 recommended**

Scope:
- Video upload endpoint (presigned MinIO URLs)
- In-browser recording with MediaRecorder API
- FFmpeg transcoding worker (Docker container)
- HLS packaging (1080p, 720p, 480p profiles)
- Thumbnail and animated preview generation
- WhisperX auto-captioning (VTT subtitles)
- HLS.js video player component
- Video posts in feed (inline player)

Deliverables:
- `ffmpeg-worker` Docker service
- Video upload API + presigned URL flow
- `<InBrowserRecorder />` component
- Transcode job queue (Redis or PostgreSQL)
- `<VideoPlayer />` component with HLS.js
- Video post type in feed
- `videos` and `transcode_jobs` database tables

Effort: ~140 engineering hours

---

### Phase 4: Livestreaming
**Timeline: 2-3 weeks | Dependencies: Phase 1, Phase 2 | Hardware: CPX41 minimum**

Scope:
- LiveKit Ingress deployment (RTMP + WHIP ingest)
- RTMP streaming to YouTube/Twitch/Facebook via Egress
- Self-hosted HLS output (MinIO + nginx)
- HLS viewer page in Rivr
- Simulcast to multiple platforms
- Chat overlay (Matrix integration)
- Stream key management UI

Deliverables:
- Ingress service in Docker Compose
- `/api/livestreams/*` endpoints
- `<LivestreamViewer />` component (HLS.js)
- Stream key generation and management
- RTMP target configuration UI
- Chat overlay component
- Caddy/nginx configuration for HLS serving

Effort: ~100 engineering hours

---

### Phase 5: Reels (Short-Form Vertical Video)
**Timeline: 2-3 weeks | Dependencies: Phase 3 | Hardware: Same as Phase 3**

Scope:
- Vertical video recording UI (9:16 aspect ratio)
- Duration enforcement (15-90 seconds)
- Vertical-scroll snap feed component
- Auto-play with muted audio
- Group-scoped reels tab
- Discovery/explore feed (cross-group)
- Reel-specific transcoding profile (optimized for mobile)

Deliverables:
- `<ReelRecorder />` component (9:16 camera UI)
- `<ReelsFeed />` component (vertical scroll)
- `<ReelPlayer />` component (auto-play, loop)
- Reels tab in group page
- Discover/explore feed page
- Reel-specific FFmpeg profile

Effort: ~80 engineering hours

---

### Phase 6: Training Mode
**Timeline: 3-4 weeks | Dependencies: Phase 1, Phase 2 | Hardware: CPX41 minimum**

Scope:
- Host control panel (mute all, spotlight, lock room)
- Breakout rooms (create, assign, move participants)
- Hand raise queue
- Polls and Q&A
- Chapter markers during recording
- Post-session training material assembly
- Integration with Marketplace for paid trainings

Deliverables:
- `<TrainingHostControls />` component
- `<BreakoutRoomManager />` component
- `<HandRaiseQueue />` component
- `<PollCreator />` and `<PollViewer />` components
- `<QAPanel />` component
- Chapter marker UI + post-processing
- Training material assembly pipeline
- Marketplace ticket verification for paid events

Effort: ~160 engineering hours

---

### Total Effort Summary

| Phase | Timeline | Effort | Cumulative |
|-------|----------|--------|-----------|
| Phase 1: Meeting Rooms | 3-4 weeks | 120 hours | 120 hours |
| Phase 2: Recording + Transcription | 2-3 weeks | 100 hours | 220 hours |
| Phase 3: Video Posts | 3-4 weeks | 140 hours | 360 hours |
| Phase 4: Livestreaming | 2-3 weeks | 100 hours | 460 hours |
| Phase 5: Reels | 2-3 weeks | 80 hours | 540 hours |
| Phase 6: Training Mode | 3-4 weeks | 160 hours | 700 hours |

**Total: ~700 engineering hours across ~18-22 weeks**

### Hardware Upgrade Timeline

| Phase | Minimum Hardware | Recommended |
|-------|-----------------|-------------|
| Phase 1 | CPX31 (current) | CPX31 |
| Phase 2 | CPX31 (tight) | CPX41 (EUR 27/mo) |
| Phase 3-4 | CPX41 | CPX41 |
| Phase 5-6 | CPX41 | CPX51 (EUR 55/mo) or split architecture |

### Quick Wins (Can Start Immediately)

1. **DNS setup:** Create `livekit.rivr.social` and `turn.rivr.social` A records pointing to Camalot host
2. **Docker pull:** Pre-pull LiveKit images on Camalot host
3. **Token server refactor:** Make room name dynamic in existing `Autobot/token-server/server.js`
4. **MinIO buckets:** Create `rivr-recordings`, `rivr-raw`, `rivr-processed` buckets

---

## Sources

### LiveKit Documentation
- [Self-hosting overview](https://docs.livekit.io/transport/self-hosting/)
- [Virtual machine deployment](https://docs.livekit.io/transport/self-hosting/vm/)
- [Egress service](https://docs.livekit.io/transport/self-hosting/egress/)
- [Ingress service](https://docs.livekit.io/transport/self-hosting/ingress/)
- [Benchmarking](https://docs.livekit.io/transport/self-hosting/benchmark/)
- [Egress overview](https://docs.livekit.io/transport/media/ingress-egress/egress/)
- [Output & streaming options](https://docs.livekit.io/transport/media/ingress-egress/egress/outputs/)
- [Ingress overview](https://docs.livekit.io/transport/media/ingress-egress/ingress/)
- [React quickstart](https://docs.livekit.io/transport/sdk-platforms/react/)
- [Next.js quickstart](https://docs.livekit.io/home/quickstarts/nextjs/)
- [Room management](https://docs.livekit.io/home/server/managing-rooms/)
- [Speech-to-text models](https://docs.livekit.io/agents/models/stt/)
- [Rooms, participants, and tracks](https://docs.livekit.io/home/get-started/api-primitives)

### LiveKit Pricing & Blog
- [Pricing](https://livekit.com/pricing)
- [Towards a future-aligned pricing model](https://blog.livekit.io/towards-a-future-aligned-pricing-model/)
- [Going beyond a single core](https://blog.livekit.io/going-beyond-a-single-core-4a464d20d17a/)
- [Universal Egress launch](https://blog.livekit.io/livekit-universal-egress-launch/)
- [Video conferencing use case](https://livekit.com/use-cases/video-conferencing)

### LiveKit GitHub
- [livekit/livekit config-sample.yaml](https://github.com/livekit/livekit/blob/master/config-sample.yaml)
- [livekit/egress](https://github.com/livekit/egress)
- [livekit/ingress](https://github.com/livekit/ingress)
- [anguzo/livekit-self-hosted docker-compose](https://github.com/anguzo/livekit-self-hosted/blob/main/docker-compose.yaml)
- [livekit-examples/meet](https://github.com/livekit-examples/meet)
- [livekit-examples/agent-starter-react](https://github.com/livekit-examples/agent-starter-react)

### Comparisons & Alternatives
- [LiveKit alternatives (GetStream)](https://getstream.io/blog/livekit-alternatives/)
- [LiveKit vs Jitsi (Dyte)](https://dyte.io/livekit-vs-jitsi)
- [Jitsi vs LiveKit (Jitsi Guide)](https://jitsi.guide/blog/jitsi-vs-livekit/)
- [Agora vs Twilio comparison (Ably)](https://ably.com/compare/agora-vs-twilio)
- [Agora vs Twilio vs Vonage vs Zoom vs VideoSDK](https://www.videosdk.live/blog/agora-vs-twilio-vs-vonage-vs-zoom-vs-video-sdk-comparison)
- [Amazon Chime alternatives (VideoSDK)](https://www.videosdk.live/blog/amazon-chime-sdk-alternative)
- [Jitsi competitors (VideoSDK)](https://www.videosdk.live/blog/jitsi-competitors)
- [Janus WebRTC gateway (Digital Samba)](https://www.digitalsamba.com/blog/why-janus-is-digital-sambas-favorite-sfu)

### Pricing
- [Daily.co pricing](https://www.daily.co/pricing/video-sdk/)
- [LiveKit pricing (SoftwareSuggest)](https://www.softwaresuggest.com/livekit)
- [LiveKit pricing guide (Voice Mode)](https://voice-mode.readthedocs.io/en/stable/livekit/pricing/)
- [Video SDK pricing (Dyte)](https://dyte.io/blog/video-sdk-pricing/)

### WhisperX & Transcription
- [WhisperLiveKit (GitHub)](https://github.com/QuentinFuxa/WhisperLiveKit)
- [WhisperLiveKit (PyPI)](https://pypi.org/project/whisperlivekit/0.1.6/)
- [Best APIs for real-time speech recognition 2026 (AssemblyAI)](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)

### Video Processing & HLS
- [Building a Modern HLS Video Player with Next.js (Medium)](https://medium.com/@dilshanmw717/building-a-modern-hls-video-player-with-next-js-a-complete-guide-19c39c61ae73)
- [HLS.js in 2025 complete guide (VideoSDK)](https://www.videosdk.live/developer-hub/hls/hls-js)
- [Next.js real-time video streaming (LogRocket)](https://blog.logrocket.com/next-js-real-time-video-streaming-hls-js-alternatives/)
- [Next.js video guides](https://nextjs.org/docs/app/guides/videos)
- [StreamForge video transcoding (GitHub)](https://github.com/Vignesh9123/video-transcoding-e2e)
- [Event-driven HLS platform (Medium)](https://medium.com/@nileshdeshpandework/building-an-event-driven-hls-video-streaming-platform-with-ffmpeg-and-microservices-1839adabbb85)

### Hardware & Infrastructure
- [Hetzner CPX31 specs (VPSBenchmarks)](https://www.vpsbenchmarks.com/hosters/hetzner/plans/cpx31)
- [Hetzner Cloud pricing](https://www.hetzner.com/cloud/regular-performance)
- [CPX31 details (Spare Cores)](https://sparecores.com/server/hcloud/cpx31)

### MediaRecorder & Browser APIs
- [MediaRecorder API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)
- [MediaStream Recording API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/MediaStream_Recording_API)
- [Building record.a.video (api.video)](https://api.video/blog/tutorials/building-record-a-video-the-mediarecorder-api/)
