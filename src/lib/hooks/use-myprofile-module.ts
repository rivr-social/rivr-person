"use client";

import { useEffect, useState } from "react";
import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";

type LoadState = "idle" | "loading" | "loaded" | "error";

export function useMyProfileModule(enabled: boolean) {
  const [bundle, setBundle] = useState<MyProfileModuleBundle | null>(null);
  const [manifest, setManifest] = useState<BespokeModuleManifest | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setBundle(null);
      setManifest(null);
      setState("idle");
      setError(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setState("loading");
      setError(null);

      try {
        const bundleResponse = await fetch("/api/myprofile", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        const bundleJson = (await bundleResponse.json()) as MyProfileModuleBundle & {
          error?: string;
        };

        if (!bundleResponse.ok || !bundleJson.success) {
          throw new Error(bundleJson.error || "Failed to load myprofile bundle");
        }

        const manifestResponse = await fetch(bundleJson.module.manifestEndpoint, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const manifestJson = (await manifestResponse.json()) as {
          success?: boolean;
          error?: string;
          manifest?: BespokeModuleManifest;
        };

        if (!manifestResponse.ok || !manifestJson.success || !manifestJson.manifest) {
          throw new Error(manifestJson.error || "Failed to load myprofile manifest");
        }

        if (cancelled) return;
        setBundle(bundleJson);
        setManifest(manifestJson.manifest);
        setState("loaded");
      } catch (err) {
        if (cancelled) return;
        setBundle(null);
        setManifest(null);
        setState("error");
        setError(err instanceof Error ? err.message : "Failed to load myprofile module");
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { bundle, manifest, state, error };
}
