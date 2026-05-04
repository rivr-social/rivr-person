"use client";

/**
 * Avatar3DViewer.
 *
 * Self-hosted three.js renderer for `.glb` persona avatars. Replaces the
 * previous `<model-viewer>` web component (which was loaded from Google's
 * `ajax.googleapis.com` CDN) with the npm `three` package so the runtime
 * has no third-party script dependency.
 *
 * Behaviour:
 * - mounts a `WebGLRenderer` into a `<canvas>` sized to the host element
 * - loads the supplied `.glb` via `GLTFLoader`
 * - centers the model at the origin and uniformly scales it to fit the
 *   camera frustum so meshes of any size render at a consistent size
 * - drives the scene with `requestAnimationFrame`
 * - rotates with `OrbitControls` (auto-rotate enabled)
 * - shows a small spinner overlay until the model loads
 * - shows an inline error message if the load fails
 * - tears down the renderer, controls, geometries, materials, textures,
 *   resize listener, and animation frame on unmount
 *
 * The `.glb` itself is fetched directly from the configured object store
 * (e.g. `https://s3.camalot.me/...`). The instance MinIO bucket is already
 * present in the CSP `connect-src` allowlist, so no CSP changes are needed
 * to load the model.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AmbientLight,
  Box3,
  DirectionalLight,
  Mesh,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type Material,
  type Texture,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

/** Default container height in pixels — matches the old `<model-viewer>` preview. */
const DEFAULT_HEIGHT = 300;

/** Camera field-of-view, near/far planes. */
const CAMERA_FOV = 45;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;

/** Multiplier applied to the model's bounding-sphere radius to set camera distance. */
const FRAME_DISTANCE_FACTOR = 2.4;

/** Background-removal: alpha=0 keeps the existing card surface visible behind the canvas. */
const RENDERER_CLEAR_ALPHA = 0;

/** OrbitControls auto-rotate speed (units = controls' internal scale). */
const AUTO_ROTATE_SPEED = 1.2;

/** Light intensities — tuned to match the old `<model-viewer shadow-intensity="1">` look. */
const AMBIENT_INTENSITY = 0.9;
const DIRECTIONAL_INTENSITY = 1.2;

/** Directional light position (above + in front of the camera). */
const DIRECTIONAL_POSITION: [number, number, number] = [3, 5, 4];

/* ── Types ── */

export interface Avatar3DViewerProps {
  /** Absolute URL of the `.glb` to render. */
  src: string;
  /** Accessibility label for the canvas region. */
  alt?: string;
  /** Container height in pixels. Defaults to 300 to match the old preview. */
  height?: number;
}

/* ── Helpers ── */

/**
 * Recursively dispose every geometry, material, and texture under `root`.
 *
 * GLTFLoader returns a tree of `Object3D`s. three.js only frees GPU
 * resources when they are explicitly disposed; otherwise unmounting the
 * component leaks WebGL buffers/textures.
 */
function disposeObject3D(root: Object3D): void {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const materialOrList = mesh.material as Material | Material[] | undefined;
      if (Array.isArray(materialOrList)) {
        for (const material of materialOrList) disposeMaterial(material);
      } else if (materialOrList) {
        disposeMaterial(materialOrList);
      }
    }
  });
}

/**
 * Dispose a single material, including any textures it references.
 *
 * Textures are stored as ad-hoc properties on materials (e.g. `map`,
 * `normalMap`, `roughnessMap`); we walk the material's keys and dispose
 * any value that quacks like a `Texture`.
 */
function disposeMaterial(material: Material): void {
  const record = material as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value && typeof value === "object" && "isTexture" in value && (value as Texture).isTexture) {
      (value as Texture).dispose();
    }
  }
  material.dispose();
}

/* ── Component ── */

/**
 * Renders a `.glb` as a self-hosted three.js scene. See module-level
 * comment for full behaviour notes.
 */
export function Avatar3DViewer({
  src,
  alt,
  height = DEFAULT_HEIGHT,
}: Avatar3DViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    setIsLoading(true);
    setErrorMessage(null);

    const width = container.clientWidth;
    const initialHeight = container.clientHeight || height;

    /* ── Scene scaffolding ── */

    const scene = new Scene();
    const camera = new PerspectiveCamera(
      CAMERA_FOV,
      width / initialHeight,
      CAMERA_NEAR,
      CAMERA_FAR,
    );
    camera.position.set(0, 0, 5);

    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, initialHeight);
    renderer.setClearColor(0x000000, RENDERER_CLEAR_ALPHA);
    container.appendChild(renderer.domElement);

    scene.add(new AmbientLight(0xffffff, AMBIENT_INTENSITY));
    const directional = new DirectionalLight(0xffffff, DIRECTIONAL_INTENSITY);
    directional.position.set(...DIRECTIONAL_POSITION);
    scene.add(directional);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;

    /* ── Loaded-model handle (so cleanup can dispose it) ── */

    let loadedRoot: Object3D | null = null;
    let cancelled = false;

    /* ── GLB load ── */

    const loader = new GLTFLoader();
    loader.load(
      src,
      (gltf) => {
        if (cancelled) {
          disposeObject3D(gltf.scene);
          return;
        }
        const model = gltf.scene;

        // Center the bounding box at the origin.
        const box = new Box3().setFromObject(model);
        const size = new Vector3();
        box.getSize(size);
        const center = new Vector3();
        box.getCenter(center);
        model.position.sub(center);

        // Frame the camera to fit the model's bounding sphere.
        const maxDimension = Math.max(size.x, size.y, size.z) || 1;
        const fovRadians = (CAMERA_FOV * Math.PI) / 180;
        const distance =
          (maxDimension / 2 / Math.tan(fovRadians / 2)) * FRAME_DISTANCE_FACTOR;
        camera.position.set(0, 0, distance);
        camera.near = Math.max(distance / 100, CAMERA_NEAR);
        camera.far = Math.max(distance * 100, CAMERA_FAR);
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();

        scene.add(model);
        loadedRoot = model;
        setIsLoading(false);
      },
      undefined,
      (error) => {
        if (cancelled) return;
        const message =
          error instanceof Error
            ? error.message
            : "Unknown error while loading 3D model.";
        setErrorMessage(message);
        setIsLoading(false);
      },
    );

    /* ── Resize handling ── */

    const handleResize = () => {
      const nextWidth = container.clientWidth;
      const nextHeight = container.clientHeight || height;
      if (nextWidth === 0 || nextHeight === 0) return;
      renderer.setSize(nextWidth, nextHeight);
      camera.aspect = nextWidth / nextHeight;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", handleResize);

    /* ── Animation loop ── */

    let animationFrameId = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrameId = window.requestAnimationFrame(tick);
    };
    animationFrameId = window.requestAnimationFrame(tick);

    /* ── Cleanup ── */

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      controls.dispose();
      if (loadedRoot) {
        scene.remove(loadedRoot);
        disposeObject3D(loadedRoot);
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [src, height]);

  return (
    <div className="relative w-full" style={{ height }} aria-label={alt}>
      <div
        ref={containerRef}
        className="absolute inset-0"
        role="img"
        aria-label={alt ?? "3D model preview"}
      />
      {isLoading && !errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/40 backdrop-blur-sm">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}
      {errorMessage && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80 p-4 text-center text-sm text-destructive">
          Failed to load 3D model: {errorMessage}
        </div>
      )}
    </div>
  );
}
