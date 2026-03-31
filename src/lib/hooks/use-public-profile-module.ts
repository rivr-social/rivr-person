"use client";

import { useEffect, useState } from "react";
import type { BespokeModuleManifest, PublicProfileModuleBundle } from "@/lib/bespoke/types";

type LoadState = "idle" | "loading" | "loaded" | "error";

export function usePublicProfileModule(usernameOrId: string | null | undefined) {
  const [bundle, setBundle] = useState<PublicProfileModuleBundle | null>(null);
  const [manifest, setManifest] = useState<BespokeModuleManifest | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [statusCode, setStatusCode] = useState<number | null>(null);

  useEffect(() => {
    const target = usernameOrId?.trim() ?? "";
    if (!target) {
      setBundle(null);
      setManifest(null);
      setState("idle");
      setError(null);
      setStatusCode(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setState("loading");
      setError(null);
      setStatusCode(null);

      try {
        const bundleResponse = await fetch(`/api/profile/${encodeURIComponent(target)}`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        const bundleJson = (await bundleResponse.json()) as PublicProfileModuleBundle & {
          error?: string;
        };

        if (!bundleResponse.ok || !bundleJson.success) {
          setStatusCode(bundleResponse.status);
          throw new Error(bundleJson.error || "Failed to load public profile bundle");
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
          setStatusCode(manifestResponse.status);
          throw new Error(manifestJson.error || "Failed to load public profile manifest");
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
        setError(err instanceof Error ? err.message : "Failed to load public profile module");
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [usernameOrId]);

  return { bundle, manifest, state, error, statusCode };
}
