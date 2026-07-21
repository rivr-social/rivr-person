"""Unit tests for the live-avatar worker's pure pieces.

Covers the puppet engine (rig build + frame render, with injected
landmarks so MediaPipe isn't required) and the audio/text envelope
math. Run: pytest test_worker.py -v
"""

from __future__ import annotations

import numpy as np
import pytest

from audio_env import (
    AudioDecodeError,
    count_syllables,
    decode_audio_to_pcm,
    envelope_from_pcm,
    envelope_from_text,
    estimate_speech_duration_ms,
)
from engine import (
    FaceLayout,
    build_rig,
    fallback_face_layout,
    render_frame,
    resize_portrait,
)

FPS = 8.0


def make_test_portrait(width: int = 320, height: int = 400) -> np.ndarray:
    """Synthetic face-ish image: bright oval on gray, dark mouth line."""
    image = np.full((height, width, 3), 90, dtype=np.uint8)
    yy, xx = np.mgrid[0:height, 0:width]
    oval = ((xx - width / 2) / (width * 0.3)) ** 2 + (
        (yy - height / 2) / (height * 0.38)
    ) ** 2 <= 1.0
    image[oval] = (200, 180, 170)
    image[int(height * 0.7) : int(height * 0.72), int(width * 0.35) : int(width * 0.65)] = (
        40,
        30,
        30,
    )
    return image


def make_layout(width: int = 320, height: int = 400) -> FaceLayout:
    return FaceLayout(
        mouth_center=(width * 0.5, height * 0.71),
        mouth_width=width * 0.3,
        left_eye=(width * 0.35, height * 0.42),
        right_eye=(width * 0.65, height * 0.42),
        eye_width=width * 0.08,
        face_height=height * 0.6,
        detected=True,
    )


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------


class TestResizePortrait:
    def test_downscales_to_max_dim(self):
        big = np.zeros((1200, 900, 3), dtype=np.uint8)
        resized = resize_portrait(big, max_dim=512)
        assert max(resized.shape[:2]) == 512
        # Aspect ratio preserved (1200:900 = 4:3 -> 512:384).
        assert resized.shape[:2] == (512, 384)

    def test_leaves_small_images_alone(self):
        small = np.zeros((200, 100, 3), dtype=np.uint8)
        assert resize_portrait(small, max_dim=512).shape == (200, 100, 3)


class TestBuildRig:
    def test_rig_with_injected_layout(self):
        image = make_test_portrait()
        rig = build_rig(image, layout=make_layout())
        assert rig.base.shape == image.shape
        assert rig.mouth_field.shape == image.shape[:2]
        assert rig.blink_field.shape == image.shape[:2]
        assert rig.layout.detected

    def test_mouth_field_peaks_below_lip_line(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        peak_y, peak_x = np.unravel_index(
            np.argmax(rig.mouth_field), rig.mouth_field.shape
        )
        mouth_cx, mouth_cy = rig.layout.mouth_center
        assert peak_y >= mouth_cy  # jaw region, not the upper face
        assert abs(peak_x - mouth_cx) < rig.layout.mouth_width

    def test_mouth_field_zero_above_lip_line(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        upper_face = rig.mouth_field[: int(rig.layout.mouth_center[1] * 0.8), :]
        assert float(upper_face.max()) == 0.0

    def test_blink_field_covers_both_eyes(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        for eye_x, eye_y in (rig.layout.left_eye, rig.layout.right_eye):
            assert rig.blink_field[int(eye_y), int(eye_x)] > 0.5

    def test_fallback_layout_when_detection_finds_nothing(self):
        # Solid-noise image: guaranteed no face whichever detector runs.
        noise = np.random.default_rng(7).integers(
            0, 255, size=(300, 300, 3), dtype=np.uint8
        )
        rig = build_rig(noise)
        assert rig.mouth_field.max() > 0.0  # still animatable
        layout = fallback_face_layout(300, 300)
        if not rig.layout.detected:
            assert rig.layout.mouth_center == layout.mouth_center


class TestRenderFrame:
    def test_returns_valid_jpeg(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        frame = render_frame(rig, mouth_amp=0.0, blink_amp=0.0, sway_time_s=0.0)
        assert frame[:2] == b"\xff\xd8"  # JPEG SOI marker
        assert len(frame) > 1000

    def test_open_mouth_changes_pixels(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        closed = render_frame(rig, 0.0, 0.0, 0.0)
        open_ = render_frame(rig, 1.0, 0.0, 0.0)
        assert closed != open_

    def test_blink_changes_pixels(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        eyes_open = render_frame(rig, 0.0, 0.0, 0.0)
        eyes_shut = render_frame(rig, 0.0, 1.0, 0.0)
        assert eyes_open != eyes_shut

    def test_amplitudes_are_clamped(self):
        rig = build_rig(make_test_portrait(), layout=make_layout())
        # Out-of-range inputs must not raise.
        render_frame(rig, -3.0, 7.0, 123.4)


# ---------------------------------------------------------------------------
# Envelopes
# ---------------------------------------------------------------------------


class TestPcmEnvelope:
    def test_silence_yields_zero_envelope(self):
        silence = np.zeros(16_000, dtype=np.float32)  # 1s
        envelope = envelope_from_pcm(silence, FPS)
        assert len(envelope) == 8
        assert all(value == 0.0 for value in envelope)

    def test_loud_burst_lands_in_right_frame(self):
        pcm = np.zeros(16_000, dtype=np.float32)
        pcm[8_000:10_000] = 0.8  # burst in second half
        envelope = envelope_from_pcm(pcm, FPS)
        assert max(envelope[:4]) == 0.0
        assert max(envelope[4:]) > 0.5

    def test_envelope_values_bounded(self):
        rng = np.random.default_rng(3)
        pcm = rng.normal(0, 0.3, size=32_000).astype(np.float32)
        envelope = envelope_from_pcm(pcm, FPS)
        assert all(0.0 <= value <= 1.0 for value in envelope)

    def test_empty_pcm(self):
        assert envelope_from_pcm(np.array([], dtype=np.float32), FPS) == []


class TestDecodeAudio:
    def test_rejects_empty_payload(self):
        with pytest.raises(AudioDecodeError):
            decode_audio_to_pcm(b"")

    def test_rejects_garbage_bytes(self):
        with pytest.raises(AudioDecodeError):
            decode_audio_to_pcm(b"not audio at all" * 10)

    def test_decodes_wav(self):
        # Minimal 16-bit mono WAV, 0.25s of 440Hz at 16kHz.
        import io
        import wave

        sample_rate = 16_000
        samples = (
            np.sin(2 * np.pi * 440 * np.arange(sample_rate // 4) / sample_rate) * 12_000
        ).astype(np.int16)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(samples.tobytes())
        pcm = decode_audio_to_pcm(buffer.getvalue())
        assert pcm.size > 3000
        assert float(np.abs(pcm).max()) > 0.2


class TestTextEnvelope:
    def test_syllable_counting(self):
        assert count_syllables("hello world") == 3  # hel-lo world
        assert count_syllables("") == 0
        assert count_syllables("a") == 1

    def test_duration_scales_with_text(self):
        short = estimate_speech_duration_ms("Hi.")
        long = estimate_speech_duration_ms(
            "This considerably longer sentence should obviously take more time to say."
        )
        assert long > short

    def test_envelope_length_matches_duration(self):
        envelope = envelope_from_text("hello there friend", FPS, duration_ms=2000)
        assert len(envelope) == 16  # 2s * 8fps

    def test_envelope_articulates(self):
        envelope = envelope_from_text(
            "A reasonably long sentence with many syllables to articulate.", FPS
        )
        assert max(envelope) > 0.6
        assert min(envelope) < 0.4  # dips between syllables
        assert all(0.0 <= value <= 1.0 for value in envelope)


# ---------------------------------------------------------------------------
# Viseme timeline + frame pack
# ---------------------------------------------------------------------------

from engine_frames import build_frame_pack, render_pack_frame, resolve_label
from phonemes import (
    viseme_sequence_from_text,
    viseme_timeline,
    weighted_viseme_sequence,
)


def make_frame_bytes(color: tuple[int, int, int], size: int = 200) -> bytes:
    image = np.full((size, size, 3), color, dtype=np.uint8)
    ok, buf = __import__("cv2").imencode(".png", image)
    assert ok
    return buf.tobytes()


class TestVisemeTimeline:
    def test_sequence_nonempty_for_text(self):
        sequence = viseme_sequence_from_text("hello round moon")
        assert len(sequence) > 0
        assert all(isinstance(label, str) for label in sequence)

    def test_round_vowels_produce_round_shapes(self):
        sequence = viseme_sequence_from_text("ooo oooh moon")
        assert "round" in sequence

    def test_timeline_length_matches_frames(self):
        timeline = viseme_timeline("hello there friend", 24)
        assert len(timeline) == 24

    def test_silence_snaps_closed(self):
        envelope = [0.0] * 10 + [0.8] * 10
        timeline = viseme_timeline("hello hello hello", 20, envelope)
        assert all(label == "closed" for label in timeline[:10])
        assert any(label != "closed" for label in timeline[10:])

    def test_empty_frame_count(self):
        assert viseme_timeline("hi", 0) == []

    def test_weighted_sequence_has_positive_varied_weights(self):
        # "go" = brief stop + long vowel in BOTH backends (phonemizer or
        # heuristic), so weights must differ and all be positive.
        pairs = weighted_viseme_sequence("go")
        assert len(pairs) >= 2
        weights = [weight for _, weight in pairs]
        assert all(weight > 0 for weight in weights)
        assert max(weights) > min(weights)

    def test_vowels_occupy_more_frames_than_consonants(self):
        # Duration weighting: the vowel of "ba" should own most frames
        # (consonant bins are closed/slight in either backend).
        timeline = viseme_timeline("ba", 30)
        vowel_frames = [
            label for label in timeline if label not in ("slight", "closed")
        ]
        assert len(vowel_frames) > len(timeline) // 2

    def test_loud_frames_promote_openness(self):
        rank = {
            "closed": 0, "slight": 1, "round": 2,
            "wide": 2, "open": 3, "wide_open": 4,
        }
        base = viseme_timeline("hello there", 24)
        loud = viseme_timeline("hello there", 24, [0.9] * 24)
        assert all(rank[l] >= rank[b] for b, l in zip(base, loud))
        assert any(rank[l] > rank[b] for b, l in zip(base, loud))

    def test_quiet_frames_demote_openness(self):
        # 0.2 is above the silence gate but under the quiet threshold:
        # nothing should reach the widest bin.
        quiet = viseme_timeline("father calling arms", 30, [0.2] * 30)
        assert "wide_open" not in quiet
        assert any(label != "closed" for label in quiet)


class TestFramePack:
    def test_build_and_render(self):
        pack = build_frame_pack({
            "closed": make_frame_bytes((10, 10, 10)),
            "open": make_frame_bytes((200, 200, 200)),
        })
        frame_a = render_pack_frame(pack, "closed", 0.0)
        assert frame_a[:2] == b"\xff\xd8"
        # switching viseme changes output (crossfade starts)
        frame_b = render_pack_frame(pack, "open", 0.125)
        assert frame_a != frame_b

    def test_resolve_label_falls_back(self):
        pack = build_frame_pack({
            "closed": make_frame_bytes((0, 0, 0)),
            "open": make_frame_bytes((255, 255, 255)),
        })
        assert resolve_label(pack, "wide_open") == "open"
        assert resolve_label(pack, "round") == "open"
        assert resolve_label(pack, "closed") == "closed"

    def test_rest_frame_guaranteed(self):
        pack = build_frame_pack({
            "open": make_frame_bytes((100, 100, 100)),
            "wide": make_frame_bytes((150, 150, 150)),
        })
        assert "closed" in pack.frames

    def test_rejects_garbage(self):
        try:
            build_frame_pack({"closed": b"not an image"})
            raised = False
        except ValueError:
            raised = True
        assert raised
