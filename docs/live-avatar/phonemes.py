"""Text → viseme timeline for the live-avatar worker.

Maps reply text to a per-animation-frame sequence of mouth-shape labels
(the viseme-pack bins), scaled to the actual speech duration and gated by
the audio envelope (mouth closes in silences, openness tracks loudness).
Uses espeak-ng via `phonemizer` when available; falls back to a
vowel-heuristic timeline.

Frames are distributed across phones by RELATIVE DURATION (vowels linger,
stops are brief) rather than uniformly, so mouth shapes land closer to
when their sounds actually happen in the audio.
"""

from __future__ import annotations

import bisect
import logging
import re

logger = logging.getLogger("live-avatar.phonemes")

VISEME_REST = "closed"

# IPA character classes → viseme bins (coarse on purpose; 6 bins).
_ROUND_VOWELS = set("ouɔɒʊuːɵøɤwɞʉ")
_WIDE_VOWELS = set("iɪeɛæyeːiː")
_OPEN_VOWELS = set("aɑʌɐäaː")
_MID_VOWELS = set("əɜɘɚ")
_BILABIAL = set("pbm")
_LABIODENTAL = set("fv")

# Relative phone-duration weights: how many "time units" each phone class
# occupies when the sequence is stretched over the utterance. Real vowels
# run ~2-3x longer than stop consonants; uniform stretching puts every
# mouth shape slightly off-beat from the audio.
_IPA_LONG_MARK = "ː"
_ALL_VOWEL_CHARS = (
    (_ROUND_VOWELS | _WIDE_VOWELS | _OPEN_VOWELS | _MID_VOWELS) - {_IPA_LONG_MARK}
)
_STOP_CONSONANTS = set("pbtdkgʔ")
_CONTINUANT_CONSONANTS = set("fvszʃʒθðhxmnŋlrɹjw")
WEIGHT_DIPHTHONG = 2.8
WEIGHT_VOWEL = 2.2
WEIGHT_STOP = 0.7
WEIGHT_CONTINUANT = 1.2
WEIGHT_DEFAULT = 1.0
WEIGHT_LONG_BONUS = 0.6

# Envelope-driven openness: loud frames promote toward wider bins, quiet
# frames demote toward closed — the mouth tracks the actual voice energy.
# Shape bins (round/wide) keep their lip shape and are left alone.
LOUD_AMPLITUDE_THRESHOLD = 0.8
QUIET_AMPLITUDE_THRESHOLD = 0.35
_OPENNESS_PROMOTE = {"slight": "open", "open": "wide_open"}
_OPENNESS_DEMOTE = {"wide_open": "open", "open": "slight"}

_VOWEL_GROUPS = re.compile(r"[aeiouyAEIOUY]+")

try:  # phonemizer + espeak-ng are optional; heuristic fallback otherwise
    from phonemizer import phonemize as _phonemize
    from phonemizer.separator import Separator as _Separator

    _PHONEMIZER_AVAILABLE = True
except Exception:  # pragma: no cover - environment dependent
    _PHONEMIZER_AVAILABLE = False


def phoneme_string(text: str) -> str | None:
    """IPA phoneme string for `text`, or None when phonemizer is missing."""
    if not _PHONEMIZER_AVAILABLE:
        return None
    try:
        result = _phonemize(
            text,
            language="en-us",
            backend="espeak",
            separator=_Separator(phone="|", word=" "),
            strip=True,
            njobs=1,
        )
        return result if isinstance(result, str) else None
    except Exception as exc:  # pragma: no cover - runtime dependent
        logger.warning("phonemize failed: %s", exc)
        return None


def _viseme_for_phone(phone: str) -> str:
    """Coarse viseme bin for one IPA phone."""
    for char in phone:
        if char in _BILABIAL:
            return "closed"
        if char in _LABIODENTAL:
            return "wide"  # f/v: teeth on lip reads closest to the wide bin
        if char in _ROUND_VOWELS:
            return "round"
        if char in _OPEN_VOWELS:
            return "wide_open"
        if char in _WIDE_VOWELS:
            return "wide"
        if char in _MID_VOWELS:
            return "open"
    return "slight"  # consonants and everything else


def _phone_weight(phone: str) -> float:
    """Relative duration weight for one IPA phone."""
    vowel_count = sum(1 for char in phone if char in _ALL_VOWEL_CHARS)
    if vowel_count >= 2:
        weight = WEIGHT_DIPHTHONG
    elif vowel_count == 1:
        weight = WEIGHT_VOWEL
    elif any(char in _STOP_CONSONANTS for char in phone):
        weight = WEIGHT_STOP
    elif any(char in _CONTINUANT_CONSONANTS for char in phone):
        weight = WEIGHT_CONTINUANT
    else:
        weight = WEIGHT_DEFAULT
    if _IPA_LONG_MARK in phone:
        weight += WEIGHT_LONG_BONUS
    return weight


def weighted_viseme_sequence(text: str) -> list[tuple[str, float]]:
    """Ordered (viseme label, duration weight) pairs for the utterance."""
    ipa = phoneme_string(text)
    if ipa:
        phones = [p for p in re.split(r"[|\s]+", ipa) if p]
        if phones:
            return [(_viseme_for_phone(p), _phone_weight(p)) for p in phones]

    # Heuristic fallback: alternate consonant/vowel shapes per vowel group.
    sequence: list[tuple[str, float]] = []
    for word in re.findall(r"[A-Za-z']+", text):
        groups = _VOWEL_GROUPS.findall(word) or ["a"]
        for group in groups:
            sequence.append(("slight", WEIGHT_DEFAULT))
            first = group[0].lower()
            if first in "ou":
                sequence.append(("round", WEIGHT_VOWEL))
            elif first in "ie":
                sequence.append(("wide", WEIGHT_VOWEL))
            else:
                sequence.append(("open", WEIGHT_VOWEL))
    return sequence or [("open", WEIGHT_VOWEL)]


def viseme_sequence_from_text(text: str) -> list[str]:
    """Ordered viseme labels for the utterance (one per phone/syllable)."""
    return [label for label, _ in weighted_viseme_sequence(text)]


def _modulate_openness(label: str, amplitude: float) -> str:
    """Nudge openness-graded bins toward the actual voice energy."""
    if amplitude >= LOUD_AMPLITUDE_THRESHOLD:
        return _OPENNESS_PROMOTE.get(label, label)
    if amplitude <= QUIET_AMPLITUDE_THRESHOLD:
        return _OPENNESS_DEMOTE.get(label, label)
    return label


def viseme_timeline(
    text: str,
    frame_count: int,
    envelope: list[float] | None = None,
    silence_threshold: float = 0.05,
) -> list[str]:
    """Per-animation-frame viseme labels for `frame_count` frames.

    The phone sequence is stretched across the frames proportionally to
    each phone's duration weight (vowels linger, stops are brief). When an
    audio envelope is supplied, frames whose amplitude is under the
    silence threshold snap to the rest shape (mouth closed in pauses) and
    openness-graded bins promote/demote with the frame's loudness.
    """
    if frame_count <= 0:
        return []
    sequence = weighted_viseme_sequence(text)

    # Cumulative weight boundaries: frame at normalized position p shows
    # the phone whose weight span contains p * total_weight.
    boundaries: list[float] = []
    running = 0.0
    for _, weight in sequence:
        running += max(weight, 1e-6)
        boundaries.append(running)
    total_weight = boundaries[-1]

    timeline: list[str] = []
    for index in range(frame_count):
        position = (index + 0.5) / frame_count * total_weight
        phone_index = min(bisect.bisect_right(boundaries, position), len(sequence) - 1)
        label = sequence[phone_index][0]
        if envelope is not None and index < len(envelope):
            amplitude = envelope[index]
            if amplitude < silence_threshold:
                label = VISEME_REST
            else:
                label = _modulate_openness(label, amplitude)
        timeline.append(label)
    return timeline
