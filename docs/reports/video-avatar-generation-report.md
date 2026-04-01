# Video Avatar Generation from Transcript + Source Video

**Research Report -- March 2026**

**Use Case**: A user uploads source videos of themselves, provides a transcript (or has one generated from a meeting recording via WhisperX), optionally describes an environment/background, clicks "Generate Video," and receives back a video of themselves speaking the transcript.

---

## Table of Contents

1. [Current State of the Art (2025-2026)](#1-current-state-of-the-art-2025-2026)
2. [Self-Hosted Open Source Options](#2-self-hosted-open-source-options)
3. [API/SaaS Options](#3-apisaas-options)
4. [The Pipeline Architecture](#4-the-pipeline-architecture)
5. [Integration with Existing Rivr/Autobot Stack](#5-integration-with-existing-rivrautobot-stack)
6. [Cost Analysis](#6-cost-analysis)
7. [Recommended Approach](#7-recommended-approach)

---

## 1. Current State of the Art (2025-2026)

The talking-head / video avatar generation field has exploded in 2024-2025, with multiple viable open-source and commercial options. The core problem breaks into sub-tasks:

- **Lip sync**: Making a face's mouth match audio phonemes
- **Face animation**: Head movement, eye blinks, expressions, micro-movements
- **Voice cloning / TTS**: Generating audio that sounds like the target person
- **Background/environment generation**: Placing the animated person in a scene
- **Long-duration coherence**: Maintaining identity and quality over minutes, not seconds

### 1.1 Commercial SaaS Platforms

#### Hedra (hedra.com)

| Attribute | Detail |
|---|---|
| **What it does** | Omnimodal AI: processes image + text + audio simultaneously (not sequentially) for talking-head video generation |
| **Quality** | High -- natural lip sync, expression matching, multiple styles |
| **Speed** | Sub-100ms response for Live Avatars (via LiveKit); standard generation in seconds |
| **API** | Yes -- REST API, Node.js SDK, LiveKit plugin, Make.com integration |
| **Pricing** | Free: 400 credits; Basic: $10/mo (1,000 credits); Creator: $30/mo (3,600 credits); Pro: $75/mo (11,000 credits). Live Avatars: $0.05/minute |
| **Open Source** | No |
| **Key Differentiator** | First omnimodal production model; built-in TTS with voice cloning; LiveKit real-time integration |
| **API Access** | Requires Creator plan ($30/mo) or above; API key at hedra.com/api-profile |

Hedra is the strongest contender for a turnkey API solution. It accepts an image + audio and produces a talking-head video. The Live Avatars feature ($0.05/min) is exceptionally cheap for real-time use cases.

#### HeyGen (heygen.com)

| Attribute | Detail |
|---|---|
| **What it does** | AI avatar video generation with custom avatars, voice cloning, video translation |
| **Quality** | Very high -- Avatar IV produces near-photorealistic results |
| **Speed** | Standard generation: minutes; real-time streaming available |
| **API** | Yes -- REST API, pay-as-you-go credits |
| **Pricing** | Free: 3 videos/mo, 720p; Creator: $29/mo; Pro: $99/mo; Business: $149/mo. API: 1 credit = 1 min standard; Avatar IV = 6 credits/min (~$3-6/min depending on plan). Scale API from $330/mo ($0.50/credit) |
| **Open Source** | No |
| **Key Differentiator** | Most mature commercial platform; Avatar IV quality is industry-leading; video translation built in |

HeyGen is the market leader for commercial avatar video. The API is well-documented but expensive at scale -- Avatar IV quality costs roughly $3-6 per minute of generated video.

#### Synthesia

| Attribute | Detail |
|---|---|
| **What it does** | AI video generation platform focused on enterprise training/communications |
| **Quality** | High -- professional studio avatars |
| **Speed** | Minutes per video |
| **API** | Enterprise-only (historically); Creator tier may now include basic API access as of 2026 |
| **Pricing** | Starter: $18/mo; Creator: $69/mo ($49 annually); Enterprise: custom. Studio Avatars: +$1,000/year |
| **Open Source** | No |
| **Key Differentiator** | Enterprise focus; SCORM export for e-learning; 160+ stock avatars |

Synthesia is enterprise-oriented. API access is gated behind higher tiers, and custom avatar creation requires significant investment ($1,000/year for studio avatars). Not ideal for Rivr's self-serve user model.

#### D-ID

| Attribute | Detail |
|---|---|
| **What it does** | Talking head generation from a single photo + audio/text |
| **Quality** | Good -- less photorealistic than HeyGen Avatar IV but serviceable |
| **Speed** | Fast -- seconds for short clips |
| **API** | Yes -- all paid plans include API access |
| **Pricing** | Lite: $5.90/mo (10 min, watermark); Plus: ~$16/mo; Pro: ~$48/mo; Advanced: $196/mo. Enterprise: custom. Duration rounded up to nearest 15 seconds |
| **Open Source** | No |
| **Key Differentiator** | Most affordable entry-level API; simple photo-to-talking-head pipeline |

D-ID is the budget-friendly API option. Quality is a step below HeyGen but pricing is accessible for MVP testing.

#### Sync Labs (sync.so)

| Attribute | Detail |
|---|---|
| **What it does** | Studio-grade lip sync -- takes existing video + new audio and re-syncs lips |
| **Quality** | Excellent lip sync accuracy -- commercial grade |
| **Speed** | Near real-time for short clips |
| **API** | Yes -- free tier includes API access (best developer accessibility) |
| **Pricing** | Free: $0/mo with API; Hobbyist: $5/mo; Creator: $19/mo; Growth: $49/mo; Scale: $249/mo. Per-generation: $0.05/sec (~$3/min standard, $5/min pro) |
| **Open Source** | Based on Wav2Lip heritage; Sync is proprietary |
| **Key Differentiator** | API on free tier; built by the Wav2Lip team; two quality tiers |

Sync Labs is the best option for **lip-sync-only** workflows where you already have a source video and just need to re-sync lips to new audio.

### 1.2 Open-Source Models

#### MuseTalk (Tencent Music / Lyra Lab)

| Attribute | Detail |
|---|---|
| **What it does** | Real-time lip sync via latent space inpainting -- modifies face region (256x256) to match audio |
| **Quality** | High -- diffusion-based, sharper mouth regions than Wav2Lip, good teeth rendering. v1.5 (March 2025) improved clarity and identity consistency |
| **Speed** | **30+ FPS on V100** -- real-time capable |
| **VRAM** | ~4-8 GB estimated (runs on V100 16GB; no explicit VRAM stated in docs) |
| **Resolution** | Face region: 256x256 (composited back into source video) |
| **Open Source** | Yes -- training code released April 2025 |
| **Background support** | No -- lip sync only; preserves source video background |
| **Languages** | Chinese, English, Japanese tested |
| **Repository** | github.com/TMElyralab/MuseTalk |

**MuseTalk is the top recommendation for real-time lip sync.** It is fast, lightweight, and produces sharp results. The limitation is that it only modifies the mouth region -- you need a source video of the person to start with.

#### LatentSync (ByteDance)

| Attribute | Detail |
|---|---|
| **What it does** | End-to-end lip sync using audio-conditioned latent diffusion (Stable Diffusion backbone with Whisper audio embeddings) |
| **Quality** | Best lip-sync accuracy scores (LSE-C: 7.90 on HDTF benchmark); strong identity preservation |
| **Speed** | **Slow**: ~10 seconds of processing per 1 second of output on RTX 4090 (10:1 ratio) |
| **VRAM** | v1.5 inference: **8 GB**; v1.6 inference: **18 GB**; training: 20-30 GB |
| **Resolution** | 256x256 (standard); 512x512 (v1.6) |
| **Open Source** | Yes -- Apache 2.0 license |
| **Background support** | No -- lip sync only |
| **Repository** | github.com/bytedance/LatentSync |

LatentSync has the best quantitative lip-sync scores but is impractically slow for production use. A 1-minute video would take ~10 minutes to generate on an RTX 4090. Useful as a quality benchmark or for offline batch processing.

#### SadTalker

| Attribute | Detail |
|---|---|
| **What it does** | Generates talking head video from a single image + audio. Creates full head motion (nods, tilts) plus lip sync using 3DMM coefficients |
| **Quality** | Good head motion and expressions; lip sync less precise than Wav2Lip/MuseTalk |
| **Speed** | Moderate -- faster than LatentSync, slower than MuseTalk |
| **VRAM** | ~4-6 GB (runs on consumer GPUs; configurable 256/512 resolution) |
| **Resolution** | 256x256 or 512x512 |
| **Open Source** | Yes (CVPR 2023) |
| **Background support** | No -- generates face region only |
| **Key limitation** | 3DMM approach loses lip detail during fast speech; temporal artifacts |
| **Repository** | github.com/OpenTalker/SadTalker |

SadTalker is mature and well-documented but showing its age. Best for quick prototyping from a single photo.

#### Hallo2 (Fudan University)

| Attribute | Detail |
|---|---|
| **What it does** | Long-duration (up to 1 hour), high-resolution (up to 4K) audio-driven portrait animation with text prompt support |
| **Quality** | High -- supports 4K output; accepted at ICLR 2025 |
| **Speed** | Slow -- diffusion-based; tested on A100 GPUs |
| **VRAM** | ~24-40 GB estimated (tested on A100 80GB) |
| **Resolution** | Up to 4K (4096x4096) |
| **Open Source** | Yes -- code and weights on GitHub |
| **Background support** | Partial -- textual prompts can influence generation |
| **Key strength** | Only model that explicitly supports hour-long generation with temporal consistency |
| **Repository** | github.com/fudan-generative-vision/hallo2 |

Hallo2 is the quality leader for long-form content but requires serious GPU hardware (A100-class). The text prompt support for influencing generation is relevant for the environment/background use case.

#### LivePortrait (Kuaishou / Kling)

| Attribute | Detail |
|---|---|
| **What it does** | Efficient portrait animation with stitching and retargeting control -- animates static portraits using driving video or webcam |
| **Quality** | Photorealistic; emotion-aware; adopted by major video platforms (Kuaishou, Douyin, Jianying, WeChat) |
| **Speed** | **12.8ms per frame on RTX 4090** -- extremely fast (20-30x faster than diffusion methods) |
| **VRAM** | ~4-8 GB (runs on RTX 4060 with 32GB system RAM) |
| **Resolution** | High quality -- trained on 69 million frames |
| **Open Source** | Yes |
| **Background support** | No -- portrait animation only |
| **Key strength** | Fastest inference of any quality model; eye/lip retargeting control |
| **Repository** | github.com/KlingTeam/LivePortrait |

LivePortrait is blazing fast and production-proven at scale. However, it requires a **driving video** (not just audio) to animate the portrait -- it maps motion from a driver to a target image. This means you need either a webcam recording or another video to drive the animation.

#### SkyReels-A1 (Skywork AI)

| Attribute | Detail |
|---|---|
| **What it does** | Expressive portrait animation with lip sync in a video diffusion transformer. Part of the SkyReels ecosystem |
| **Quality** | Superior lip sync across Chinese, English, Korean, singing, fast dialogue. 720p HD at 24fps |
| **Speed** | Moderate -- 4-second clip in ~80 seconds on RTX 4090 (with FP8 quantization) |
| **VRAM** | ~18.5 GB on RTX 4090 (with FP8 quantization) |
| **Resolution** | 720p native |
| **Open Source** | Yes -- released February 2025 |
| **Background support** | **Yes** -- Reference-to-Video mode maintains identity fidelity for characters, objects, AND backgrounds |
| **Key strength** | Unified lip-sync + expression + body in one model; background consistency; built on HunyuanVideo |
| **Repository** | github.com/SkyworkAI/SkyReels-A1 |

SkyReels-A1 is notable because it is one of the few open-source models that handles background/environment generation alongside portrait animation. The Reference-to-Video mode can maintain scene consistency.

#### Wav2Lip (Classic)

| Attribute | Detail |
|---|---|
| **What it does** | Lip sync for existing video -- the original and most influential open-source lip sync model |
| **Quality** | Excellent sync accuracy; slightly blurry output, weak teeth rendering |
| **Speed** | Fast on consumer GPUs |
| **VRAM** | ~2-4 GB |
| **Open Source** | Yes (ACM Multimedia 2020) |
| **Repository** | github.com/Rudrabha/Wav2Lip |

The classic baseline. Wav2Lip-HQ (community enhancement) achieves the best combined scores (LSE-D: 3.74, LSE-C: 6.92, SyncNet: 7.58). Still relevant as a fast, lightweight option, but visually dated compared to diffusion-based models.

#### VideoReTalking

| Attribute | Detail |
|---|---|
| **What it does** | Re-talks existing video footage -- modifies only the mouth in existing video to match new audio |
| **Quality** | Preserves original video quality (lighting, skin, head motion); only mouth is regenerated |
| **Speed** | Slower than Wav2Lip due to multi-stage pipeline |
| **VRAM** | ~6-8 GB |
| **Open Source** | Yes |
| **Best for** | Post-production dubbing where you want to preserve everything except lip movement |

#### Other Notable Models

| Model | Status | Notes |
|---|---|---|
| **EMO (Alibaba)** | Open source | Audio-to-video diffusion model; trained on 250+ hours of footage; handles singing and multi-language; heavyweight |
| **V-Express (Tencent)** | Open source | Controllable talking head with pose + audio + image control; good infrastructure for research |
| **AniPortrait** | Open source | Transformer-based 3D facial mesh extraction from audio; diffusion-based rendering; 2024 release |
| **DreamTalk (Alibaba)** | Code open, **weights restricted** | Diffusion-based expressive generation; must email for checkpoint access; research use only |
| **NVIDIA Audio2Face-3D** | Open source (2025) | Real-time audio-to-facial-animation for 3D characters (not 2D video); C++ SDK; aimed at games/3D apps |
| **Wan2.1 (Alibaba)** | Open source (Apache 2.0) | General video generation, not talking-head-specific; 1.3B model on consumer GPU, 14B needs multi-GPU |
| **OmniHuman (ByteDance)** | API only (piapi.ai) | Film-grade talking avatar from single photo + audio; supports gestures; not self-hostable |
| **ChatAnyone** | Research (March 2025) | Real-time portrait video generation; hierarchical motion diffusion; not yet released |

### 1.3 Summary Matrix

| Model | Type | Quality | Speed | VRAM | Open Source | Background | Production Ready |
|---|---|---|---|---|---|---|---|
| **MuseTalk** | Lip sync | A- | Real-time | ~6 GB | Yes | No | Yes |
| **LatentSync** | Lip sync | A | Slow (10:1) | 8-18 GB | Yes | No | Batch only |
| **SadTalker** | Single-image talking head | B+ | Moderate | ~5 GB | Yes | No | Yes |
| **Hallo2** | Portrait animation | A | Slow | ~30 GB | Yes | Partial | Batch only |
| **LivePortrait** | Portrait animation | A | Very fast | ~6 GB | Yes | No | Yes |
| **SkyReels-A1** | Portrait + lip sync | A | Moderate | ~19 GB | Yes | **Yes** | Yes |
| **Wav2Lip** | Lip sync | B | Fast | ~3 GB | Yes | No | Yes |
| **Hedra** | Full pipeline (SaaS) | A+ | Fast | N/A | No | Built-in | Yes |
| **HeyGen** | Full pipeline (SaaS) | A+ | Fast | N/A | No | Built-in | Yes |
| **Sync Labs** | Lip sync (SaaS) | A | Fast | N/A | No | No | Yes |

---

## 2. Self-Hosted Open Source Options

### 2.1 Viable Models for Vast.ai Deployment

Given Rivr's existing pattern of renting Vast.ai GPUs (as used for Chatterbox TTS), here are the models ranked by viability for self-hosting:

#### Tier 1: Recommended for Production

**MuseTalk 1.5 on RTX 4090 ($0.29/hr on Vast.ai)**

- **Installation complexity**: Medium -- conda environment, PyTorch 2.0.1, CUDA 11.7/11.8, MMLab packages, ffmpeg
- **VRAM**: ~6 GB (fits easily on 24 GB 4090)
- **Inference time**: Real-time (30+ FPS) -- a 1-minute video generates in ~1 minute
- **Quality**: Sharp lip sync, good identity preservation, multi-language
- **Limitation**: Lip sync only -- needs source video + audio as input; does NOT generate full talking head from single image
- **Best for**: Re-syncing lips in existing video to new audio (the Chatterbox TTS output)

**LivePortrait on RTX 4090 ($0.29/hr on Vast.ai)**

- **Installation complexity**: Low-medium -- standard PyTorch setup
- **VRAM**: ~6 GB
- **Inference time**: 12.8ms per frame (~78 FPS) -- a 1-minute video at 25fps generates in ~20 seconds
- **Quality**: Photorealistic portrait animation; production-proven at Kuaishou/Douyin scale
- **Limitation**: Requires a **driving video** to map motion from -- not directly audio-driven
- **Best for**: If you can generate a driving motion sequence (from audio), this is the fastest renderer

#### Tier 2: Good Quality, Higher Requirements

**SkyReels-A1 on RTX 4090 ($0.29/hr) or A100 ($0.67/hr)**

- **Installation complexity**: Medium -- HunyuanVideo dependencies, large model download
- **VRAM**: ~18.5 GB with FP8 quantization (fits on 4090 with 24 GB)
- **Inference time**: ~80 seconds per 4-second clip = ~20 minutes per minute of output
- **Quality**: Excellent; unified lip sync + expression + body + background
- **Limitation**: Slow inference; relatively new (Feb 2025)
- **Best for**: When you need background/environment control alongside portrait animation

**LatentSync 1.5 on RTX 4090 ($0.29/hr)**

- **Installation complexity**: Low -- single setup script (`setup_env.sh`)
- **VRAM**: 8 GB for v1.5 inference
- **Inference time**: ~10 minutes per minute of output
- **Quality**: Best quantitative lip-sync scores
- **Limitation**: Very slow; 256x256 resolution for v1.5
- **Best for**: Highest-accuracy lip sync when time is not critical

#### Tier 3: Requires A100/H100

**Hallo2 on A100 ($0.67/hr)**

- **Installation complexity**: Medium -- PyTorch 2.2.2, CUDA 11.8, diffusion dependencies
- **VRAM**: ~30-40 GB (needs A100 40GB or 80GB)
- **Inference time**: Slow -- estimated 15-30 minutes per minute of output
- **Quality**: Highest quality; supports 4K; hour-long generation
- **Limitation**: Expensive GPU requirement; slow
- **Best for**: Premium long-form content where quality trumps cost

### 2.2 VRAM Requirements Summary

| Model | Min VRAM | Recommended GPU | Vast.ai Cost/hr |
|---|---|---|---|
| Wav2Lip | 3 GB | Any NVIDIA GPU | $0.10-0.20 |
| SadTalker | 5 GB | RTX 3060+ | $0.15-0.25 |
| MuseTalk 1.5 | 6 GB | RTX 3090 / 4090 | $0.29 |
| LivePortrait | 6 GB | RTX 4060+ | $0.29 |
| LatentSync 1.5 | 8 GB | RTX 3090 / 4090 | $0.29 |
| SkyReels-A1 | 19 GB | RTX 4090 (FP8) | $0.29 |
| LatentSync 1.6 | 18 GB | RTX 4090 | $0.29 |
| Hallo2 | 30+ GB | A100 40/80GB | $0.67 |

### 2.3 Background/Environment Generation

Most lip-sync models do NOT generate backgrounds -- they modify faces within existing video frames. To add environment/background prompting, you need one of:

1. **SkyReels-A1**: The only open-source model with integrated background support via Reference-to-Video mode
2. **Hallo2**: Partial support via text prompts during generation
3. **Separate background pipeline**: Use a video generation model (Wan2.1, HunyuanVideo) to generate the background, then composite the talking head onto it
4. **Green screen approach**: Generate the talking head on a neutral background, then use video matting + inpainting to place them in a prompted environment

For the MVP, the most practical approach is to use the **source video's original background** or allow users to select from pre-rendered environment templates, rather than generating custom backgrounds per-request.

---

## 3. API/SaaS Options

### 3.1 Pricing Comparison (Per Minute of Generated Video)

| Service | Cost/Minute | Latency | Quality | API Complexity |
|---|---|---|---|---|
| **Hedra** (standard) | ~$0.03-0.08/credit (depends on plan, ~$0.30-0.75/min) | Seconds | High | Simple REST |
| **Hedra Live Avatar** | $0.05/min | Sub-100ms | High | LiveKit SDK |
| **HeyGen** (standard) | ~$0.50-1.00/min | Minutes | Very High | REST + webhooks |
| **HeyGen** (Avatar IV) | ~$3.00-6.00/min | Minutes | Exceptional | REST + webhooks |
| **D-ID** | ~$0.50-2.00/min (plan dependent) | Seconds | Good | REST |
| **Sync Labs** (standard) | $3.00/min | Seconds | Excellent sync | REST |
| **Sync Labs** (pro) | $5.00/min | Seconds | Studio grade | REST |
| **Synthesia** | Plan-based (no per-min API) | Minutes | High | Enterprise REST |
| **fal.ai** (MuseTalk) | ~$0.05-0.10/run | Seconds | Good | REST |
| **fal.ai** (Kling LipSync) | $0.014/sec (~$0.84/min) | Seconds | High | REST |
| **Replicate** (various) | $0.05-0.50/run | Seconds | Varies | REST |

### 3.2 Privacy and Data Retention

| Service | Data Retention | Privacy Notes |
|---|---|---|
| **Hedra** | Stored on their servers; deletion available | Standard cloud privacy |
| **HeyGen** | Videos stored in account; enterprise: custom retention | SOC 2 compliant |
| **D-ID** | Cloud storage; deletion on request | GDPR compliant |
| **Synthesia** | Enterprise data controls | SOC 2, GDPR, ISO 27001 |
| **Sync Labs** | Processed and stored; API tier controls | Standard |
| **Self-hosted** | **Full control** -- data never leaves your infrastructure | Best for privacy |

For Rivr's use case where users upload personal video of themselves, **self-hosted is strongly preferred for privacy**. Users' face data, voice data, and meeting transcripts are sensitive. Sending them to third-party APIs introduces compliance risk.

### 3.3 API Integration Complexity

**Simplest to integrate**: Hedra, D-ID, Sync Labs -- straightforward REST APIs, quick response times, minimal webhook complexity.

**Most complex**: HeyGen (webhook-based async flow, credit management), Synthesia (enterprise gating, complex avatar setup).

**Best developer experience**: Sync Labs (API on free tier, simple endpoint), Hedra (good docs, starter repo on GitHub).

---

## 4. The Pipeline Architecture

### 4.1 Full Pipeline Design

```
User uploads source videos (10-60 sec)
    |
    v
Source videos stored in MinIO
    |
    v
User provides transcript text
  (OR: WhisperX transcribes meeting audio -> humanizer cleanup)
    |
    v
User optionally describes environment
  ("in a professional office", "outdoors at sunset")
    |
    v
User clicks "Generate Video"
    |
    +---> [Step 1] Chatterbox TTS (Vast.ai GPU)
    |       Input: transcript text + voice reference WAV (from source video)
    |       Output: cloned-voice audio (MP3/WAV)
    |       Time: ~real-time (faster than real-time with Turbo)
    |
    +---> [Step 2] Extract reference frames from source video
    |       Input: source video from MinIO
    |       Output: key frames + face crop + audio reference
    |
    v
    [Step 3] Video Avatar Generation (Vast.ai GPU)
        Input: source video + cloned-voice audio from Step 1
        Output: video with lip-synced face matching new audio
        Time: depends on model (real-time with MuseTalk, 10-20x with others)
    |
    v
    [Step 4] (Optional) Background compositing
        If environment prompt provided:
          - Extract foreground (face/body) via video matting
          - Generate or select background
          - Composite layers
    |
    v
    [Step 5] Final MP4 encoding + upload to MinIO
    |
    v
    Video displayed in Rivr event/post/profile
```

### 4.2 Source Video Requirements

| Approach | Source Material Needed | Notes |
|---|---|---|
| **Lip sync only** (MuseTalk, Wav2Lip) | 10-60 seconds of existing video of the person speaking | Model re-syncs lips to new audio; original head motion/background preserved |
| **Single image + audio** (SadTalker, Hallo2) | 1 photo of the person | Generates full head motion from scratch; less natural than video-based |
| **Reference video + audio** (SkyReels-A1) | 1-4 reference images or short video clip | Generates new video maintaining identity; can include background |

**Recommendation**: Ask users to upload 15-30 seconds of themselves speaking on camera. This provides:
- Face reference for identity preservation
- Voice reference for Chatterbox TTS cloning (5+ seconds of clean audio)
- Head motion patterns for natural-looking output
- Original background (if no environment prompt is given)

### 4.3 Audio Generation

The pipeline requires **separate TTS** -- the video avatar models do NOT generate audio. They take audio as input and generate matching video.

**Pipeline**: Transcript text --> Chatterbox TTS (cloned voice) --> Audio WAV --> Video model (lip sync)

This is ideal because:
1. Chatterbox Turbo already runs on Vast.ai in the existing Autobot stack
2. Voice cloning from 5 seconds of reference audio (extracted from user's source video)
3. MIT licensed, 23 languages, emotion control
4. Faster-than-real-time inference

### 4.4 Background/Environment Generation

Three approaches, in order of practicality:

**Option A: Use source video background (simplest, MVP)**
- User's source video already has a background
- MuseTalk/Wav2Lip only modify the mouth region, preserving the original background
- No additional processing needed
- Limitation: Output always has the same background as the source video

**Option B: Template backgrounds (medium effort)**
- Pre-render a set of environment videos (office, outdoor, studio, etc.)
- Use video matting (e.g., RobustVideoMatting) to extract the person from source video
- Composite person onto template background
- Gives users a "choose your background" dropdown

**Option C: AI-generated backgrounds (most complex)**
- Use SkyReels-A1 which supports background generation natively
- Or use a separate pipeline: video generation model (Wan2.1/HunyuanVideo) for background + compositing
- Highest flexibility but adds significant GPU time and complexity

### 4.5 GPU Provisioning

Following the existing Chatterbox pattern (see `Autobot/chatterbox/bringup-vast.sh`):

```bash
# GPU filter for video avatar generation
GPU_FILTER="reliability > 0.98 num_gpus=1 gpu_ram>=24 inet_down>100 dph<0.60"

# For MuseTalk (lightweight)
GPU_FILTER_MUSETALK="reliability > 0.98 num_gpus=1 gpu_ram>=16 inet_down>100 dph<0.40"

# For SkyReels-A1 / Hallo2 (heavyweight)
GPU_FILTER_HEAVY="reliability > 0.98 num_gpus=1 gpu_ram>=40 inet_down>100 dph<1.00"
```

The provisioning flow mirrors the Chatterbox pattern:
1. OpenClaw gateway receives "generate video" request
2. Checks for existing Vast.ai instance with video model loaded
3. If none, provisions new instance via `vastai create instance`
4. Waits for instance to reach running state
5. Rsync model code + upload source video + audio
6. Run inference
7. Download result MP4
8. Optionally destroy instance (or keep warm for batch jobs)

For cost optimization, the video model can share a GPU instance with Chatterbox TTS since:
- Chatterbox uses ~4 GB VRAM
- MuseTalk uses ~6 GB VRAM
- RTX 4090 has 24 GB -- plenty of room for both

---

## 5. Integration with Existing Rivr/Autobot Stack

### 5.1 Existing Infrastructure

| Component | Current State | Role in Video Avatar Pipeline |
|---|---|---|
| **Chatterbox TTS** | Running on Vast.ai; OpenClaw-compatible API at `/v1/audio/speech` | Step 1: Generate cloned-voice audio from transcript |
| **OpenClaw Gateway** | Manages Vast.ai GPU lifecycle; token server proxies requests | Orchestrates GPU provisioning and API routing |
| **WhisperX** | Handles transcription of meeting audio | Provides input transcripts with speaker labels |
| **MinIO** | Object storage for media files | Stores source videos, generated audio, output videos |
| **Rivr Person App** | Next.js frontend | UI for upload, transcript editing, video generation trigger |
| **Event/Post system** | Document storage with transcript content | Contains the text to be spoken |

### 5.2 Proposed Pipeline Integration

```
WhisperX transcript (with speaker labels + timestamps)
    |
    v
Humanizer cleanup (existing) -- polishes raw transcript
    |
    v
Chatterbox TTS (existing Vast.ai service)
    Input: cleaned transcript + voice reference WAV
    Output: cloned-voice audio file --> stored in MinIO
    |
    v
Video Avatar Service (NEW -- same Vast.ai instance or separate)
    Input: source video (from MinIO) + cloned audio (from MinIO)
    Output: lip-synced video --> stored in MinIO
    |
    v
(Optional) Background compositor
    Input: lip-synced video + environment prompt
    Output: final composited video --> stored in MinIO
    |
    v
Rivr frontend displays generated video
```

### 5.3 New Components Needed

1. **Video Avatar Server** (`Autobot/video-avatar/server.py`) -- FastAPI service similar to `chatterbox/server.py`:
   - `POST /v1/video/generate` -- accepts source video URL + audio URL, returns generated video
   - `GET /health` -- health check
   - Auth token protection (same pattern as Chatterbox)
   - Model loading on first request (lazy initialization)

2. **Vast.ai bringup script** (`Autobot/video-avatar/bringup-vast.sh`) -- mirrors `chatterbox/bringup-vast.sh`:
   - Provisions RTX 4090 instance
   - Installs dependencies (PyTorch, MuseTalk/chosen model, ffmpeg)
   - Starts the video avatar server
   - Reports connection details

3. **Token server route** -- Add `/api/video-avatar` proxy route in `Autobot/token-server/server.js`

4. **Rivr Person UI components**:
   - Source video upload interface (in profile or event view)
   - "Generate Video" button with transcript input
   - Environment/background selector (optional)
   - Progress indicator (generation takes seconds to minutes)
   - Video player for result

5. **MinIO integration** -- New bucket or prefix for video avatar assets:
   - `video-avatar/source/{userId}/{videoId}.mp4` -- uploaded source videos
   - `video-avatar/audio/{userId}/{jobId}.wav` -- generated TTS audio
   - `video-avatar/output/{userId}/{jobId}.mp4` -- final generated video

### 5.4 Server API Design

```python
# POST /v1/video/generate
{
    "source_video_url": "https://minio.example.com/video-avatar/source/user123/ref.mp4",
    "audio_url": "https://minio.example.com/video-avatar/audio/user123/job456.wav",
    "model": "musetalk-1.5",        # or "latentsync-1.5", "skyreels-a1"
    "environment": null,             # optional: "professional office"
    "resolution": "720p",            # 720p or 1080p
    "fps": 25
}

# Response (async -- returns job ID)
{
    "job_id": "job_789",
    "status": "processing",
    "estimated_seconds": 60
}

# GET /v1/video/status/{job_id}
{
    "job_id": "job_789",
    "status": "completed",
    "output_url": "https://minio.example.com/video-avatar/output/user123/job789.mp4",
    "duration_seconds": 63.5,
    "processing_time_seconds": 58.2
}
```

---

## 6. Cost Analysis

### 6.1 Self-Hosted Costs (Vast.ai)

#### MuseTalk on RTX 4090 (Recommended)

| Metric | Value |
|---|---|
| GPU rental | $0.29/hr |
| Inference speed | Real-time (~1:1) |
| Cost per minute of output | **$0.005** (29 cents/hr / 60 min) |
| Setup time (cold start) | ~5-10 minutes (instance boot + model load) |
| Effective cost including setup | ~$0.05-0.10 for first minute, $0.005 for subsequent |

#### LatentSync 1.5 on RTX 4090

| Metric | Value |
|---|---|
| GPU rental | $0.29/hr |
| Inference speed | ~10:1 (10 min processing per 1 min output) |
| Cost per minute of output | **$0.048** |
| Best for | Highest quality offline batch processing |

#### SkyReels-A1 on RTX 4090

| Metric | Value |
|---|---|
| GPU rental | $0.29/hr |
| Inference speed | ~20:1 (20 min processing per 1 min output) |
| Cost per minute of output | **$0.097** |
| Advantage | Includes background/environment generation |

#### Hallo2 on A100

| Metric | Value |
|---|---|
| GPU rental | $0.67/hr |
| Inference speed | ~20:1 estimated |
| Cost per minute of output | **$0.22** |
| Advantage | 4K output, hour-long generation |

#### Combined Pipeline Cost (Chatterbox TTS + MuseTalk)

Sharing a single RTX 4090 instance ($0.29/hr):

| Step | Time | Cost |
|---|---|---|
| Chatterbox TTS (1 min audio) | ~30 sec | $0.002 |
| MuseTalk lip sync (1 min video) | ~60 sec | $0.005 |
| FFmpeg encoding | ~10 sec | negligible |
| **Total per minute of output** | **~100 sec** | **~$0.008** |

With cold start overhead (5-10 min instance boot):

| Scenario | Total Cost |
|---|---|
| Single 1-min video (cold start) | ~$0.05-0.10 |
| Single 5-min video (cold start) | ~$0.09-0.14 |
| Batch of 10x 1-min videos (warm) | ~$0.08 |

### 6.2 API Service Costs

| Service | Cost per Minute | 10 Min Video | 60 Min Video |
|---|---|---|---|
| **Self-hosted (MuseTalk)** | $0.008 | $0.08 | $0.48 |
| **Hedra** (standard) | ~$0.50 | $5.00 | $30.00 |
| **Hedra** (Live Avatar) | $0.05 | $0.50 | $3.00 |
| **D-ID** (plan-based) | ~$1.00 | $10.00 | $60.00 |
| **HeyGen** (standard API) | ~$0.50 | $5.00 | $30.00 |
| **HeyGen** (Avatar IV) | ~$4.00 | $40.00 | $240.00 |
| **Sync Labs** (standard) | $3.00 | $30.00 | $180.00 |
| **fal.ai** (MuseTalk) | ~$0.10 | $1.00 | $6.00 |

**Self-hosted is 10-100x cheaper than API services for sustained use.** The break-even point is approximately 10-20 minutes of generated video per month before self-hosted becomes clearly more economical than any API.

### 6.3 Monthly Cost Projections

Assuming a Rivr deployment generates 60 minutes of avatar video per month:

| Approach | Monthly Cost |
|---|---|
| Self-hosted MuseTalk (on-demand Vast.ai) | ~$2-5 |
| Self-hosted MuseTalk (reserved instance) | ~$12-15 |
| Hedra API (standard) | ~$30 |
| Hedra Live Avatar API | ~$3 |
| HeyGen API (standard) | ~$30 |
| fal.ai (MuseTalk hosted) | ~$6 |
| D-ID API | ~$60 |

---

## 7. Recommended Approach

### 7.1 Best Open-Source Model for Self-Hosting

**Primary: MuseTalk 1.5** -- for lip sync on existing video

- Real-time inference on RTX 4090 ($0.29/hr)
- Best speed-to-quality ratio
- 6 GB VRAM leaves room to co-host Chatterbox TTS on same GPU
- Sharp output with good identity preservation
- Active development (v1.5 released March 2025, training code April 2025)

**Secondary: SkyReels-A1** -- when background/environment generation is needed

- Only open-source option with integrated background support
- 18.5 GB VRAM on 4090 with FP8 quantization
- Slower (~20 min per min of output) but higher flexibility
- Use for premium/featured content where custom environments are requested

**Quality fallback: LatentSync 1.5** -- when maximum lip-sync accuracy is required

- Best quantitative lip-sync scores
- Only 8 GB VRAM for inference
- Slow but highest fidelity

### 7.2 Fallback API Service

**Primary fallback: Hedra**
- Best developer experience (REST API, starter repo, docs)
- Live Avatar at $0.05/min is surprisingly affordable
- Built-in TTS with voice cloning (could replace Chatterbox for this flow)
- LiveKit integration aligns with potential real-time use cases

**Budget fallback: fal.ai**
- Hosts multiple models (MuseTalk, LatentSync, Kling LipSync, Sync Lipsync)
- Pay-per-run pricing
- Simple REST API
- Useful for testing different models without self-hosting each one

### 7.3 MVP Implementation Plan

#### Phase 1: Core Pipeline (2-3 weeks)

1. **Video Avatar Server** -- Create `Autobot/video-avatar/` with:
   - `server.py` -- FastAPI service wrapping MuseTalk 1.5
   - `bringup-vast.sh` -- Vast.ai provisioning (copy pattern from `chatterbox/bringup-vast.sh`)
   - `requirements.txt` -- MuseTalk dependencies
   - Endpoints: `/v1/video/generate`, `/v1/video/status/{job_id}`, `/health`

2. **Token Server Integration** -- Add video-avatar proxy route in `Autobot/token-server/server.js`

3. **Pipeline Orchestration**:
   - Accept transcript + source video
   - Extract voice reference from source video (ffmpeg)
   - Call Chatterbox TTS for audio generation
   - Call Video Avatar for lip-synced video
   - Store result in MinIO
   - Return video URL

4. **Basic Rivr UI** -- "Generate Video" button in event/post view:
   - Upload source video (or select from previously uploaded)
   - Paste/edit transcript
   - Click generate
   - Show progress
   - Display result

#### Phase 2: Quality and Features (2-3 weeks)

5. **Background options** -- Add environment selector:
   - "Original background" (default -- uses source video background)
   - Template backgrounds (pre-rendered office, outdoor, studio scenes)
   - Custom prompt (routes to SkyReels-A1 instead of MuseTalk)

6. **Batch processing** -- For meeting transcripts:
   - WhisperX transcript with speaker labels
   - Generate video for each speaker segment
   - Concatenate segments into full video
   - Handle speaker transitions

7. **Quality improvements**:
   - Super-resolution pass on output (Real-ESRGAN or similar)
   - Audio-video sync verification
   - Face detection confidence thresholds

#### Phase 3: Polish and Scale (2-3 weeks)

8. **GPU management**:
   - Instance pooling (keep warm instances for frequent users)
   - Auto-shutdown idle instances after 10 minutes
   - Queue system for concurrent requests

9. **User experience**:
   - Source video guidelines ("face centered, good lighting, 15-30 sec")
   - Preview before full generation
   - Edit and re-generate workflow
   - Download/share options

10. **Monitoring**:
    - Generation time tracking
    - Quality metrics (face detection confidence, sync scores)
    - Cost per user/generation tracking

### 7.4 UX Design: "Click a Button"

```
+--------------------------------------------------+
|  Event: Q1 Planning Meeting                       |
|  Transcript: [View Full Transcript]               |
|                                                   |
|  +---------------------------------------------+ |
|  | Generate Video Summary                       | |
|  |                                              | |
|  | Source Video: [Upload] or [Use Profile Video] | |
|  |   cameron-reference.mp4 (uploaded)    [x]    | |
|  |                                              | |
|  | Transcript: (auto-filled from event)         | |
|  | +------------------------------------------+ | |
|  | | "Welcome everyone to Q1 planning. Let's  | | |
|  | | start by reviewing our objectives..."     | | |
|  | +------------------------------------------+ | |
|  | [Edit Transcript]                            | |
|  |                                              | |
|  | Background: [Original] [Office] [Custom...] | |
|  |                                              | |
|  | [Generate Video]                             | |
|  +---------------------------------------------+ |
|                                                   |
|  Generated Videos:                                |
|  +---------------------------------------------+ |
|  | [>] Q1 Planning Summary - 2:34              | |
|  |     Generated Mar 28, 2026                   | |
|  |     [Download] [Share] [Regenerate]          | |
|  +---------------------------------------------+ |
+--------------------------------------------------+
```

### 7.5 Architecture Decision Record

| Decision | Choice | Rationale |
|---|---|---|
| Primary model | MuseTalk 1.5 | Best speed/quality/cost ratio; real-time on 4090 |
| GPU provider | Vast.ai (on-demand) | Already used for Chatterbox; cheapest option |
| GPU type | RTX 4090 (24GB) | $0.29/hr; enough VRAM for MuseTalk + Chatterbox |
| TTS engine | Chatterbox Turbo | Already deployed; MIT license; 5-sec voice cloning |
| Audio format | WAV (internal), MP3 (delivery) | WAV for model input quality; MP3 for storage/delivery |
| Video format | MP4 (H.264) | Universal playback; good compression |
| Storage | MinIO | Existing infrastructure; presigned URLs for GPU access |
| API pattern | Async (job queue) | Video generation takes 30-120 sec; polling/webhook pattern |
| Background (MVP) | Source video original | Simplest; no additional model needed |
| Background (v2) | Template selection + SkyReels-A1 | User choice with AI fallback |
| Fallback API | Hedra ($0.05/min live, ~$0.50/min standard) | Best DX; affordable; built-in voice cloning |

---

## Appendix A: Key Repository Links

| Project | Repository | License |
|---|---|---|
| MuseTalk | github.com/TMElyralab/MuseTalk | Open source |
| LatentSync | github.com/bytedance/LatentSync | Apache 2.0 |
| SadTalker | github.com/OpenTalker/SadTalker | Open source |
| Hallo2 | github.com/fudan-generative-vision/hallo2 | Open source |
| LivePortrait | github.com/KlingTeam/LivePortrait | Open source |
| SkyReels-A1 | github.com/SkyworkAI/SkyReels-A1 | Open source |
| Wav2Lip | github.com/Rudrabha/Wav2Lip | Open source |
| VideoReTalking | github.com/OpenTalker/video-retalking | Open source |
| V-Express | github.com/tencent-ailab/V-Express | Open source |
| Chatterbox TTS | github.com/resemble-ai/chatterbox | MIT |
| NVIDIA Audio2Face | github.com/NVIDIA/Audio2Face-3D | Open source |
| Wan2.1 | github.com/Wan-Video/Wan2.1 | Apache 2.0 |

## Appendix B: Research Sources

- Hedra: hedra.com, hedra.com/plans, hedra.com/docs
- HeyGen: heygen.com/api-pricing, docs.heygen.com
- Synthesia: synthesia.io/pricing, docs.synthesia.io
- D-ID: d-id.com/pricing/api, d-id.com/api
- Sync Labs: sync.so/pricing
- fal.ai: fal.ai/pricing, fal.ai/models
- Vast.ai: vast.ai/pricing
- Pixazo model comparison: pixazo.ai/blog/best-open-source-lip-sync-models
- lipsync.com comparison: lipsync.com/blog/open-source-lip-sync
- lipsync.com pricing: lipsync.com/pricing
