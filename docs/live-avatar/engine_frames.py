"""Viseme frame-pack engine for the live-avatar worker.

When a session carries a baked viseme pack (photoreal mouth-shape frames
of the SAME portrait, generated once on a GPU), animation becomes frame
selection + crossfade instead of warping. Pack v2 adds:

* an openness LADDER (step_00..step_NN, frames sorted by mouth openness)
  — transitions walk real in-between shapes instead of alpha-blending;
* region variants (eyes_closed / brows_raised) composited through
  feathered masks — blink and brow emphasis on photoreal frames.

Runtime cost stays a few blends + one affine per frame — CPU-light.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field

import cv2
import numpy as np

from engine import (
    JPEG_QUALITY,
    MAX_DIM,
    SWAY_ROTATE_DEG,
    SWAY_SHIFT_PX,
    SWAY_SPEED,
    detect_face_layout,
)

logger = logging.getLogger("live-avatar.frames")

VISEME_REST = "closed"
CROSSFADE_FRAMES = 2

# Where each mouth bin sits on the openness ladder (0 = shut, 1 = widest).
_BIN_LADDER_ANCHOR = {
    "closed": 0.0,
    "slight": 0.25,
    "wide": 0.30,
    "round": 0.50,
    "open": 0.55,
    "wide_open": 1.0,
}

_STEP_LABEL = re.compile(r"^step_(\d{2})$")
_REGION_LABELS = ("eyes_closed", "brows_raised")

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
    """Decoded, size-normalized viseme frames plus transition state."""

    frames: dict[str, np.ndarray]
    width: int
    height: int
    #: Ordered ladder step labels (ascending openness); empty = no ladder.
    ladder: list[str] = field(default_factory=list)
    #: Feathered masks for region compositing (None when regions absent).
    eye_mask: np.ndarray | None = None
    brow_mask: np.ndarray | None = None
    current_label: str = VISEME_REST
    previous_label: str = VISEME_REST
    blend_progress: float = 1.0  # 1.0 = fully on current frame

    @property
    def size(self) -> tuple[int, int]:
        return self.width, self.height


def _ellipse_mask(
    shape: tuple[int, int],
    centers: list[tuple[float, float]],
    semi_x: float,
    semi_y: float,
) -> np.ndarray:
    """Feathered (gaussian) union of ellipses, float32 0..1."""
    height, width = shape
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
    mask = np.zeros((height, width), dtype=np.float32)
    for cx, cy in centers:
        dist = ((xx - cx) / max(semi_x, 1.0)) ** 2 + ((yy - cy) / max(semi_y, 1.0)) ** 2
        np.maximum(mask, np.exp(-dist * 2.2), out=mask)
    return mask


def build_frame_pack(images: dict[str, bytes]) -> FramePack:
    """Decode label→PNG/JPEG bytes into a normalized FramePack.

    All frames resize to the first frame's (downscaled) geometry so blends
    are pixel-aligned. Region masks come from FaceMesh landmarks on the
    rest frame (regions are skipped when detection fails — never fatal).
    Raises ValueError when nothing decodes.
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

    ladder = sorted(
        (label for label in decoded if _STEP_LABEL.match(label)),
        key=lambda label: int(_STEP_LABEL.match(label).group(1)),
    )

    # Region masks — only worth computing when a region frame exists.
    eye_mask = brow_mask = None
    if any(label in decoded for label in _REGION_LABELS):
        layout = detect_face_layout(decoded[VISEME_REST])
        if layout is not None and layout.detected:
            centers = [layout.left_eye, layout.right_eye]
            eye_w = max(layout.eye_width, 4.0)
            shape = decoded[VISEME_REST].shape[:2]
            if "eyes_closed" in decoded:
                eye_mask = _ellipse_mask(shape, centers, eye_w * 1.7, eye_w * 1.1)
            if "brows_raised" in decoded:
                brow_centers = [(cx, cy - eye_w * 1.2) for cx, cy in centers]
                brow_mask = _ellipse_mask(shape, brow_centers, eye_w * 2.1, eye_w * 1.3)
        else:
            logger.info("region frames present but face undetected; regions off")

    return FramePack(
        frames=decoded,
        width=target[0],
        height=target[1],
        ladder=ladder,
        eye_mask=eye_mask,
        brow_mask=brow_mask,
    )


def resolve_label(pack: FramePack, label: str) -> str:
    if label in pack.frames:
        return label
    for fallback in _FALLBACK_ORDER.get(label, []):
        if fallback in pack.frames:
            return fallback
    return next(iter(pack.frames))


def _ladder_frame(pack: FramePack, position: float) -> np.ndarray | None:
    """Ladder frame nearest the normalized openness position, or None."""
    if not pack.ladder:
        return None
    index = round(max(0.0, min(1.0, position)) * (len(pack.ladder) - 1))
    return pack.frames.get(pack.ladder[index])


def _composite_region(
    frame: np.ndarray,
    region: np.ndarray | None,
    mask: np.ndarray | None,
    amount: float,
) -> np.ndarray:
    if region is None or mask is None or amount <= 0.0:
        return frame
    alpha = (mask * min(1.0, amount))[..., np.newaxis]
    return (frame.astype(np.float32) * (1.0 - alpha) + region.astype(np.float32) * alpha).astype(
        np.uint8
    )


def render_pack_frame(
    pack: FramePack,
    viseme: str,
    sway_time_s: float,
    blink_amp: float = 0.0,
    brow_amp: float = 0.0,
) -> bytes:
    """Render one JPEG frame: viseme (via ladder transitions when baked),
    blink/brow region compositing, crossfade, and idle sway."""
    label = resolve_label(pack, viseme)

    if label != pack.current_label:
        pack.previous_label = pack.current_label
        pack.current_label = label
        pack.blend_progress = 0.0

    if pack.blend_progress < 1.0:
        pack.blend_progress = min(1.0, pack.blend_progress + 1.0 / CROSSFADE_FRAMES)

    current = pack.frames[pack.current_label]
    frame: np.ndarray | None = None
    if pack.blend_progress >= 1.0 or pack.previous_label not in pack.frames:
        frame = current.copy()
    else:
        # Mid-transition: walk real in-between mouth shapes when the pack
        # carries an openness ladder and both endpoints sit on it.
        from_anchor = _BIN_LADDER_ANCHOR.get(pack.previous_label)
        to_anchor = _BIN_LADDER_ANCHOR.get(pack.current_label)
        if from_anchor is not None and to_anchor is not None:
            position = from_anchor + (to_anchor - from_anchor) * pack.blend_progress
            ladder = _ladder_frame(pack, position)
            if ladder is not None:
                frame = ladder.copy()
        if frame is None:
            previous = pack.frames[pack.previous_label]
            frame = cv2.addWeighted(
                current, pack.blend_progress, previous, 1.0 - pack.blend_progress, 0.0,
            )

    # Region compositing happens pre-sway — all pack frames are aligned.
    frame = _composite_region(frame, pack.frames.get("eyes_closed"), pack.eye_mask, blink_amp)
    frame = _composite_region(frame, pack.frames.get("brows_raised"), pack.brow_mask, brow_amp)

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
