"use client";

/**
 * Lightweight 3D model viewer component.
 *
 * Renders .glb/.gltf models using @react-three/fiber and @react-three/drei.
 * Unsupported formats (.fbx, .obj, .vrm) show a fallback with filename and download link.
 *
 * Three.js is lazy-loaded to keep the initial bundle small.
 */

import { Suspense, lazy, useMemo } from "react";
import { Download, Box } from "lucide-react";
import { Button } from "@/components/ui/button";

/* ── Constants ── */

const SUPPORTED_VIEWER_EXTENSIONS = new Set([".glb", ".gltf"]);

/* ── Helpers ── */

function getFileExtension(url: string): string {
  try {
    const pathname = new URL(url, "https://placeholder.local").pathname;
    const lastDot = pathname.lastIndexOf(".");
    return lastDot >= 0 ? pathname.slice(lastDot).toLowerCase() : "";
  } catch {
    return "";
  }
}

function getFilename(url: string): string {
  try {
    const pathname = new URL(url, "https://placeholder.local").pathname;
    return pathname.split("/").pop() ?? "3d-model";
  } catch {
    return "3d-model";
  }
}

/* ── Lazy-loaded Three.js scene ── */

const ThreeScene = lazy(() => import("./three-d-scene"));

/* ── Public component ── */

type ThreeDViewerProps = {
  url: string;
  title?: string;
  className?: string;
  /** When true, renders inline at the card's aspect ratio. Otherwise renders in a larger dialog view. */
  inline?: boolean;
};

export function ThreeDViewer({ url, title, className, inline = false }: ThreeDViewerProps) {
  const extension = useMemo(() => getFileExtension(url), [url]);
  const filename = useMemo(() => getFilename(url), [url]);
  const canRender = SUPPORTED_VIEWER_EXTENSIONS.has(extension);

  if (!canRender) {
    return (
      <ThreeDFallback url={url} filename={title ?? filename} />
    );
  }

  return (
    <div className={className ?? (inline ? "aspect-video w-full" : "w-full h-[400px]")}>
      <Suspense fallback={<ThreeDLoadingPlaceholder />}>
        <ThreeScene url={url} />
      </Suspense>
    </div>
  );
}

/* ── Fallback for unsupported formats ── */

function ThreeDFallback({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-6 bg-muted/50 rounded-md aspect-video">
      <Box className="h-10 w-10 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground text-center truncate max-w-full">
        {filename}
      </p>
      <p className="text-xs text-muted-foreground/60">
        Preview not available for this format
      </p>
      <Button variant="outline" size="sm" asChild>
        <a href={url} download>
          <Download className="mr-2 h-3.5 w-3.5" />
          Download
        </a>
      </Button>
    </div>
  );
}

/* ── Loading placeholder ── */

function ThreeDLoadingPlaceholder() {
  return (
    <div className="flex items-center justify-center w-full h-full bg-muted/30 rounded-md">
      <div className="flex flex-col items-center gap-2">
        <Box className="h-8 w-8 text-muted-foreground/40 animate-pulse" />
        <p className="text-xs text-muted-foreground/60">Loading 3D viewer...</p>
      </div>
    </div>
  );
}
