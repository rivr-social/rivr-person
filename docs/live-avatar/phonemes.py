"""Text → viseme timeline for the live-avatar worker.

Maps reply text to a per-animation-frame sequence of mouth-shape labels
(the viseme-pack bins), scaled to the actual speech duration and gated by
the audio envelope (mouth closes in silences). Uses espeak-ng via
`phonemizer` when available; falls back to a vowel-heuristic timeline.
"""

from __future__ import annotations

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


def viseme_sequence_from_text(text: str) -> list[str]:
    """Ordered viseme labels for the utterance (one per phone/syllable)."""
    ipa = phoneme_string(text)
    if ipa:
        phones = [p for p in re.split(r"[|\s]+", ipa) if p]
        if phones:
            return [_viseme_for_phone(p) for p in phones]

    # Heuristic fallback: alternate consonant/vowel shapes per vowel group.
    sequence: list[str] = []
    for word in re.findall(r"[A-Za-z']+", text):
        groups = _VOWEL_GROUPS.findall(word) or ["a"]
        for group in groups:
            sequence.append("slight")
            first = group[0].lower()
            if first in "ou":
                sequence.append("round")
            elif first in "ie":
                sequence.append("wide")
            else:
                sequence.append("open")
    return sequence or ["open"]


def viseme_timeline(
    text: str,
    frame_count: int,
    envelope: list[float] | None = None,
    silence_threshold: float = 0.05,
) -> list[str]:
    """Per-animation-frame viseme labels for `frame_count` frames.

    The phone sequence is stretched uniformly across the frames; when an
    audio envelope is supplied, frames whose amplitude is under the
    silence threshold snap to the rest shape (mouth closed in pauses).
    """
    if frame_count <= 0:
        return []
    sequence = viseme_sequence_from_text(text)
    timeline: list[str] = []
    for index in range(frame_count):
        position = int(index * len(sequence) / frame_count)
        label = sequence[min(position, len(sequence) - 1)]
        if envelope is not None and index < len(envelope):
            if envelope[index] < silence_threshold:
                label = VISEME_REST
        timeline.append(label)
    return timeline
