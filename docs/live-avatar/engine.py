"""Portrait puppet engine for the live-avatar worker.

Turns a single reference portrait into an animatable "talking picture":
MediaPipe face landmarks locate the mouth and eyes, and precomputed
displacement fields (jaw drop, blink) are scaled per-frame by an audio
envelope and re-applied with cv2.remap. No generative model, no weights,
no GPU requirement -- a frame renders in ~1-2ms at 512px on CPU.

The public surface (build_rig / render_frame) is engine-agnostic so a
LivePortrait-class engine can replace it behind the same worker API.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass

import cv2
import numpy as np

logger = logging.getLogger("live-avatar.engine")

# ---------------------------------------------------------------------------
# Tunables (single source of truth for the puppet look)
# ---------------------------------------------------------------------------

MAX_DIM = 512                 # portraits are downscaled so max(H, W) <= this
JPEG_QUALITY = 70
MOUTH_MAX_DROP_FRAC = 0.045   # jaw drop at full amplitude, as a fraction of face height
MOUTH_SHADE_ALPHA = 0.5       # inner-mouth darkening at full amplitude
BLINK_CLOSE_FRAC = 0.9        # how fully a blink closes the eyes (0..1)
SWAY_ROTATE_DEG = 0.7         # idle head-sway rotation amplitude
SWAY_SHIFT_PX = 1.5           # idle head-sway vertical drift amplitude
SWAY_SPEED = 0.55             # sway oscillations per second

# Heuristic layout used when no face is detected (cartoons, statues, logos):
# animate a plausible mouth/eye region so any picture still "talks".
FALLBACK_MOUTH_CENTER = (0.5, 0.72)   # (x, y) as fractions of image size
FALLBACK_EYE_Y = 0.42
FALLBACK_EYE_X_OFFSET = 0.16
FALLBACK_FACE_HEIGHT_FRAC = 0.6

try:  # MediaPipe is optional -- the heuristic rig keeps the worker functional.
    import mediapipe as mp

    _MEDIAPIPE_AVAILABLE = True
except Exception:  # pragma: no cover - import availability depends on platform
    _MEDIAPIPE_AVAILABLE = False


# MediaPipe FaceMesh landmark indices (canonical 468-point topology).
_LM_UPPER_LIP = 13
_LM_LOWER_LIP = 14
_LM_MOUTH_LEFT = 61
_LM_MOUTH_RIGHT = 291
_LM_LEFT_EYE = 159   # left upper eyelid midpoint
_LM_RIGHT_EYE = 386  # right upper eyelid midpoint
_LM_CHIN = 152
_LM_FOREHEAD = 10


@dataclass
class FaceLayout:
    """Pixel-space anchor points driving the displacement fields."""

    mouth_center: tuple[float, float]
    mouth_width: float
    left_eye: tuple[float, float]
    right_eye: tuple[float, float]
    eye_width: float
    face_height: float
    detected: bool


@dataclass
class PortraitRig:
    """Everything precomputed once per session; render_frame only remaps."""

    base: np.ndarray          # BGR uint8, resized
    grid_x: np.ndarray        # float32 identity meshgrid
    grid_y: np.ndarray
    mouth_field: np.ndarray   # (H, W) float32 weight, 0..1
    blink_field: np.ndarray   # (H, W) float32 weight, 0..1
    layout: FaceLayout

    @property
    def size(self) -> tuple[int, int]:
        height, width = self.base.shape[:2]
        return width, height


# ---------------------------------------------------------------------------
# Landmark detection
# ---------------------------------------------------------------------------


def detect_face_layout(image_bgr: np.ndarray) -> FaceLayout | None:
    """Locate mouth/eye anchors with MediaPipe FaceMesh; None when undetected."""
    if not _MEDIAPIPE_AVAILABLE:
        return None

    height, width = image_bgr.shape[:2]
    try:
        with mp.solutions.face_mesh.FaceMesh(
            static_image_mode=True,
            max_num_faces=1,
            refine_landmarks=False,
            min_detection_confidence=0.4,
        ) as mesh:
            result = mesh.process(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB))
    except Exception as exc:  # pragma: no cover - runtime-environment dependent
        logger.warning("FaceMesh inference failed: %s", exc)
        return None

    if not result.multi_face_landmarks:
        return None

    points = result.multi_face_landmarks[0].landmark

    def px(index: int) -> tuple[float, float]:
        landmark = points[index]
        return (landmark.x * width, landmark.y * height)

    upper_lip = px(_LM_UPPER_LIP)
    lower_lip = px(_LM_LOWER_LIP)
    mouth_left = px(_LM_MOUTH_LEFT)
    mouth_right = px(_LM_MOUTH_RIGHT)
    left_eye = px(_LM_LEFT_EYE)
    right_eye = px(_LM_RIGHT_EYE)
    chin = px(_LM_CHIN)
    forehead = px(_LM_FOREHEAD)

    return FaceLayout(
        mouth_center=(
            (upper_lip[0] + lower_lip[0]) / 2.0,
            (upper_lip[1] + lower_lip[1]) / 2.0,
        ),
        mouth_width=max(8.0, abs(mouth_right[0] - mouth_left[0])),
        left_eye=left_eye,
        right_eye=right_eye,
        eye_width=max(6.0, abs(right_eye[0] - left_eye[0]) * 0.22),
        face_height=max(24.0, abs(chin[1] - forehead[1])),
        detected=True,
    )


def fallback_face_layout(width: int, height: int) -> FaceLayout:
    """Plausible anchors for images where no face is detected."""
    return FaceLayout(
        mouth_center=(width * FALLBACK_MOUTH_CENTER[0], height * FALLBACK_MOUTH_CENTER[1]),
        mouth_width=width * 0.22,
        left_eye=(width * (0.5 - FALLBACK_EYE_X_OFFSET), height * FALLBACK_EYE_Y),
        right_eye=(width * (0.5 + FALLBACK_EYE_X_OFFSET), height * FALLBACK_EYE_Y),
        eye_width=width * 0.07,
        face_height=height * FALLBACK_FACE_HEIGHT_FRAC,
        detected=False,
    )


# ---------------------------------------------------------------------------
# Rig construction
# ---------------------------------------------------------------------------


def _gaussian_weight(
    grid_x: np.ndarray,
    grid_y: np.ndarray,
    center: tuple[float, float],
    sigma_x: float,
    sigma_y: float,
) -> np.ndarray:
    cx, cy = center
    return np.exp(
        -(
            ((grid_x - cx) ** 2) / (2.0 * sigma_x**2)
            + ((grid_y - cy) ** 2) / (2.0 * sigma_y**2)
        )
    ).astype(np.float32)


def resize_portrait(image_bgr: np.ndarray, max_dim: int = MAX_DIM) -> np.ndarray:
    height, width = image_bgr.shape[:2]
    scale = max_dim / max(height, width)
    if scale >= 1.0:
        return image_bgr
    return cv2.resize(
        image_bgr,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def build_rig(image_bgr: np.ndarray, layout: FaceLayout | None = None) -> PortraitRig:
    """Precompute the identity grid and displacement weights for a portrait.

    `layout` is injectable for tests; production callers let detection run.
    """
    base = resize_portrait(image_bgr)
    height, width = base.shape[:2]

    if layout is None:
        layout = detect_face_layout(base) or fallback_face_layout(width, height)

    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )

    # Jaw-drop weight: strongest just below the lip line, fading over the chin.
    mouth_cx, mouth_cy = layout.mouth_center
    jaw_center = (mouth_cx, mouth_cy + layout.face_height * 0.08)
    mouth_field = _gaussian_weight(
        grid_x,
        grid_y,
        jaw_center,
        sigma_x=layout.mouth_width * 0.85,
        sigma_y=layout.face_height * 0.14,
    )
    # Only pixels at/below the lip line move (the upper face stays anchored).
    mouth_field *= (grid_y >= mouth_cy - layout.face_height * 0.03).astype(np.float32)

    # Blink weight: one lobe per eye, covering the eyelid region.
    blink_field = np.zeros((height, width), dtype=np.float32)
    for eye in (layout.left_eye, layout.right_eye):
        blink_field += _gaussian_weight(
            grid_x,
            grid_y,
            eye,
            sigma_x=layout.eye_width,
            sigma_y=layout.eye_width * 0.7,
        )
    blink_field = np.clip(blink_field, 0.0, 1.0)

    return PortraitRig(
        base=base,
        grid_x=grid_x,
        grid_y=grid_y,
        mouth_field=mouth_field,
        blink_field=blink_field,
        layout=layout,
    )


# ---------------------------------------------------------------------------
# Frame rendering
# ---------------------------------------------------------------------------


def render_frame(
    rig: PortraitRig,
    mouth_amp: float,
    blink_amp: float,
    sway_time_s: float,
) -> bytes:
    """Render one JPEG frame. Amplitudes are 0..1; sway_time_s is wall time."""
    mouth_amp = float(np.clip(mouth_amp, 0.0, 1.0))
    blink_amp = float(np.clip(blink_amp, 0.0, 1.0))

    height, width = rig.base.shape[:2]
    mouth_drop_px = mouth_amp * MOUTH_MAX_DROP_FRAC * rig.layout.face_height
    blink_px = blink_amp * BLINK_CLOSE_FRAC * rig.layout.eye_width * 0.8

    # remap: dst(x, y) samples src(map_x, map_y). Sampling from *above*
    # (map_y = y - d) shifts content downward -> jaw drop / lid closing.
    map_x = rig.grid_x
    map_y = rig.grid_y - (mouth_drop_px * rig.mouth_field + blink_px * rig.blink_field)

    frame = cv2.remap(
        rig.base,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )

    # Inner-mouth shading sells the open mouth far more than the warp alone.
    if mouth_amp > 0.05:
        mouth_cx, mouth_cy = rig.layout.mouth_center
        overlay = frame.copy()
        cv2.ellipse(
            overlay,
            (int(mouth_cx), int(mouth_cy + mouth_drop_px * 0.45)),
            (
                max(2, int(rig.layout.mouth_width * 0.32)),
                max(1, int(mouth_drop_px * 0.55 + rig.layout.mouth_width * 0.05)),
            ),
            0,
            0,
            360,
            (20, 12, 12),
            thickness=-1,
        )
        alpha = MOUTH_SHADE_ALPHA * mouth_amp
        frame = cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0.0)

    # Idle sway keeps the portrait alive between utterances.
    angle = SWAY_ROTATE_DEG * math.sin(2.0 * math.pi * SWAY_SPEED * sway_time_s)
    shift_y = SWAY_SHIFT_PX * math.sin(2.0 * math.pi * SWAY_SPEED * 0.63 * sway_time_s)
    rotation = cv2.getRotationMatrix2D((width / 2.0, height / 2.0), angle, 1.0)
    rotation[1, 2] += shift_y
    frame = cv2.warpAffine(
        frame,
        rotation,
        (width, height),
        flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_REPLICATE,
    )

    ok, buffer = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return buffer.tobytes()
