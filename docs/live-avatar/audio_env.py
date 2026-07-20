"""Audio -> mouth-amplitude envelopes for the live-avatar worker.

Two sources:
  * real speech audio (Chatterbox TTS output, or any ffmpeg-decodable clip)
    -> per-frame RMS envelope, normalized and soft-compressed
  * plain text (browser-TTS fallback where no audio bytes exist server-side)
    -> synthetic syllable-bump envelope over an estimated duration
"""

from __future__ import annotations

import re
import subprocess

import numpy as np

PCM_SAMPLE_RATE = 16_000
FFMPEG_TIMEOUT_S = 30
MAX_AUDIO_BYTES = 15 * 1024 * 1024

# Conversational speech averages ~4.5 syllables/second.
SYLLABLES_PER_SECOND = 4.5
MIN_SPEECH_MS = 400
MAX_SPEECH_MS = 120_000

# Envelope shaping: soft-compress so quiet speech still moves the mouth.
ENVELOPE_COMPRESSION = 0.6
ENVELOPE_NOISE_FLOOR = 0.06

_VOWEL_GROUPS = re.compile(r"[aeiouyAEIOUY]+")


class AudioDecodeError(RuntimeError):
    """Raised when ffmpeg cannot decode the provided audio bytes."""


def decode_audio_to_pcm(audio_bytes: bytes) -> np.ndarray:
    """Decode arbitrary audio bytes to mono float32 PCM at PCM_SAMPLE_RATE."""
    if not audio_bytes:
        raise AudioDecodeError("Empty audio payload")
    if len(audio_bytes) > MAX_AUDIO_BYTES:
        raise AudioDecodeError(
            f"Audio payload exceeds {MAX_AUDIO_BYTES} bytes"
        )

    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel", "error",
                "-i", "pipe:0",
                "-f", "s16le",
                "-ac", "1",
                "-ar", str(PCM_SAMPLE_RATE),
                "pipe:1",
            ],
            input=audio_bytes,
            capture_output=True,
            timeout=FFMPEG_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired as exc:
        raise AudioDecodeError("ffmpeg timed out decoding audio") from exc
    except FileNotFoundError as exc:
        raise AudioDecodeError("ffmpeg is not installed on this host") from exc

    if proc.returncode != 0 or not proc.stdout:
        detail = proc.stderr.decode("utf-8", errors="replace")[:300]
        raise AudioDecodeError(f"ffmpeg decode failed: {detail or 'no output'}")

    samples = np.frombuffer(proc.stdout, dtype=np.int16).astype(np.float32)
    return samples / 32768.0


def envelope_from_pcm(pcm: np.ndarray, fps: float) -> list[float]:
    """Per-animation-frame mouth amplitudes (0..1) from mono PCM."""
    if pcm.size == 0:
        return []

    window = max(1, int(PCM_SAMPLE_RATE / fps))
    frame_count = max(1, int(np.ceil(pcm.size / window)))
    padded = np.zeros(frame_count * window, dtype=np.float32)
    padded[: pcm.size] = pcm

    rms = np.sqrt(np.mean(padded.reshape(frame_count, window) ** 2, axis=1))

    # Normalize against the loud end of the clip, not the absolute peak, so
    # one plosive doesn't flatten the rest of the envelope.
    reference = float(np.percentile(rms, 95))
    if reference <= 1e-6:
        return [0.0] * frame_count

    normalized = np.clip(rms / reference, 0.0, 1.0)
    normalized[normalized < ENVELOPE_NOISE_FLOOR] = 0.0
    shaped = normalized**ENVELOPE_COMPRESSION
    return [float(value) for value in shaped]


def envelope_from_audio(audio_bytes: bytes, fps: float) -> list[float]:
    return envelope_from_pcm(decode_audio_to_pcm(audio_bytes), fps)


def count_syllables(text: str) -> int:
    """Rough syllable count: vowel groups per word, minimum one per word."""
    words = re.findall(r"[A-Za-z']+", text)
    total = 0
    for word in words:
        total += max(1, len(_VOWEL_GROUPS.findall(word)))
    return total


def estimate_speech_duration_ms(text: str) -> int:
    syllables = count_syllables(text)
    duration_ms = int(syllables / SYLLABLES_PER_SECOND * 1000)
    return int(np.clip(duration_ms, MIN_SPEECH_MS, MAX_SPEECH_MS))


def envelope_from_text(text: str, fps: float, duration_ms: int | None = None) -> list[float]:
    """Synthetic per-frame envelope: one raised-cosine bump per syllable."""
    total_ms = duration_ms if duration_ms and duration_ms > 0 else estimate_speech_duration_ms(text)
    total_ms = int(np.clip(total_ms, MIN_SPEECH_MS, MAX_SPEECH_MS))
    frame_count = max(1, int(round(total_ms / 1000.0 * fps)))
    syllables = max(1, count_syllables(text))

    times = (np.arange(frame_count) + 0.5) / fps            # seconds
    syllable_rate = syllables / (total_ms / 1000.0)          # syllables/second
    # Raised-cosine oscillation at the syllable rate, dipping to ~0.15 between
    # syllables so the mouth visibly re-articulates.
    phase = 2.0 * np.pi * syllable_rate * times
    envelope = 0.15 + 0.85 * (0.5 - 0.5 * np.cos(phase))

    # Ease in/out at utterance boundaries.
    ramp_frames = max(1, int(round(fps * 0.12)))
    ramp = np.minimum(1.0, (np.arange(frame_count) + 1) / ramp_frames)
    envelope *= ramp * ramp[::-1]

    return [float(np.clip(value, 0.0, 1.0)) for value in envelope]
