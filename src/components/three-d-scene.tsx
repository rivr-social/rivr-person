// @ts-nocheck — react-three-fiber v8 JSX intrinsics are not recognized under React 19
"use client";

/**
 * Three.js scene for rendering .glb/.gltf models.
 *
 * This file is lazy-loaded by ThreeDViewer to keep Three.js out of the
 * initial bundle. It uses @react-three/fiber Canvas and @react-three/drei
 * helpers for orbit controls, environment lighting, and GLTF loading.
 */

import { Suspense } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, Environment, useGLTF, Center, ContactShadows } from "@react-three/drei";

/* ── Constants ── */

const CAMERA_FOV = 45;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;
const CAMERA_POSITION: [number, number, number] = [0, 1.5, 4];
const AUTO_ROTATE_SPEED = 1;
const CONTACT_SHADOW_OPACITY = 0.4;
const CONTACT_SHADOW_BLUR = 2.5;

/* ── Model sub-component ── */

function Model({ url }: { url: string }) {
  const { scene } = useGLTF(url);
  return (
    <Center>
      <primitive object={scene} />
    </Center>
  );
}

/* ── Scene (default export for lazy loading) ── */

type ThreeSceneProps = {
  url: string;
};

export default function ThreeScene({ url }: ThreeSceneProps) {
  return (
    <Canvas
      camera={{
        fov: CAMERA_FOV,
        near: CAMERA_NEAR,
        far: CAMERA_FAR,
        position: CAMERA_POSITION,
      }}
      style={{ width: "100%", height: "100%" }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} />
      <Suspense fallback={null}>
        <Model url={url} />
        <ContactShadows
          position={[0, -0.5, 0]}
          opacity={CONTACT_SHADOW_OPACITY}
          blur={CONTACT_SHADOW_BLUR}
        />
        <Environment preset="studio" />
      </Suspense>
      <OrbitControls
        autoRotate
        autoRotateSpeed={AUTO_ROTATE_SPEED}
        enablePan={false}
        minDistance={1}
        maxDistance={20}
      />
    </Canvas>
  );
}
