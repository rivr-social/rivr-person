"""Viseme frame-pack engine for the live-avatar worker.

When a session carries a baked viseme pack (photoreal mouth-shape frames
of the SAME portrait, generated once on a GPU), animation becomes frame
selection + crossfade instead of warping: pick the frame for the current
viseme, alpha-blend from the previous one over ~2 animation frames, and
apply the same idle sway. Runtime cost is a blend + affine per frame —
as light as the warp engine, but with real lip shapes.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from engine import JPEG_QUALITY, MAX_DIM, SWAY_ROTATE_DEG, SWAY_SHIFT_PX, SWAY_SPEED

logger = logging.getLogger("live-avatar.frames")

VISEME_REST = "closed"
CROSSFADE_FRAMES = 2

# Preference order when a requested bin is missing from the pack.
_FALLBACK_ORDER: dict[str, list[str]] = {
    "closed": ["slight", "open"],
    "slight": ["closed", "open"],
    "open": ["slight", "wide_open"],
    "wide_open": ["open", "slight"],
    "round": ["open", "slight"],
    "wide": ["slight", "open"],
}


@dataclass
class FramePack:
    """Decoded, size-normalized viseme frames plus crossfade state."""

    frames: dict[str, np.ndarray]
    width: int
    height: int
    current_label: str = VISEME_REST
    previous_label: str = VISEME_REST
    blend_progress: float = 1.0  # 1.0 = fully on current frame
    _labels: list[str] = field(default_factory=list)

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height


def build_frame_pack(images: dict[str, bytes]) -> FramePack:
    """Decode label→PNG/JPEG bytes into a normalized FramePack.

    All frames resize to the first frame's (downscaled) geometry so blends
    are pixel-aligned. Raises ValueError when nothing decodes.
    """
    decoded: dict[str, np.ndarray] = {}
    target: tuple[int, int] | None = None

    for label, data in images.items():
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            logger.warning("viseme frame %s failed to decode; skipped", label)
            continue
        if target is None:
            height, width = image.shape[:2]
            scale = min(1.0, MAX_DIM / max(height, width))
            target = (max(1, round(width * scale)), max(1, round(height * scale)))
        decoded[label] = cv2.resize(image, target, interpolation=cv2.INTER_AREA)

    if not decoded or target is None:
        raise ValueError("viseme pack contained no decodable frames")

    if VISEME_REST not in decoded:
        # Guarantee a rest frame: least-open available bin.
        for candidate in ("slight", "open", "wide", "round", "wide_open"):
            if candidate in decoded:
                decoded[VISEME_REST] = decoded[candidate]
                break

    return FramePack(
        frames=decoded,
        width=target[0],
        height=target[1],
        _labels=list(decoded.keys()),
    )


def resolve_label(pack: FramePack, label: str) -> str:
    if label in pack.frames:
        return label
    for fallback in _FALLBACK_ORDER.get(label, []):
        if fallback in pack.frames:
            return fallback
    return next(iter(pack.frames))


def render_pack_frame(pack: FramePack, viseme: str, sway_time_s: float) -> bytes:
    """Render one JPEG frame for the requested viseme with crossfade + sway."""
    label = resolve_label(pack, viseme)

    if label != pack.current_label:
        pack.previous_label = pack.current_label
        pack.current_label = label
        pack.blend_progress = 0.0

    if pack.blend_progress < 1.0:
        pack.blend_progress = min(1.0, pack.blend_progress + 1.0 / CROSSFADE_FRAMES)

    current = pack.frames[pack.current_label]
    if pack.blend_progress >= 1.0 or pack.previous_label not in pack.frames:
        frame = current.copy()
    else:
        previous = pack.frames[pack.previous_label]
        frame = cv2.addWeighted(
            current, pack.blend_progress, previous, 1.0 - pack.blend_progress, 0.0,
        )

    # Idle sway (same tunables as the warp engine — one coherent motion feel).
    angle = SWAY_ROTATE_DEG * math.sin(2.0 * math.pi * SWAY_SPEED * sway_time_s)
    shift_y = SWAY_SHIFT_PX * math.sin(2.0 * math.pi * SWAY_SPEED * 0.63 * sway_time_s)
    rotation = cv2.getRotationMatrix2D(
        (pack.width / 2.0, pack.height / 2.0), angle, 1.0,
    )
    rotation[1, 2] += shift_y
    frame = cv2.warpAffine(
        frame,
        rotation,
        (pack.width, pack.height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )

    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buffer.tobytes()
