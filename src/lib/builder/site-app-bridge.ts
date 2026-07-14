/**
 * @fileoverview Site → own-environment bridge ("it should be its own whole
 * environment deployed"). Deploys a builder SITE as a first-class STATIC APP
 * through the existing app-broker lane: the site files land in an app
 * workspace with a `rivr-app.json` static manifest and a `deploy` request is
 * queued; the HOST broker (which re-validates everything) builds the static
 * container and routes it on its own hostname — a real, isolated environment
 * instead of the in-instance serve path.
 *
 * Trust model unchanged: this module only writes the workspace + spool files
 * the broker contract already accepts (`app-lifecycle.ts`); it never touches
 * Docker or the host shell.
 */
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { getAgentAppWorkspaceRoot } from "@/lib/agent-hq";
import {
  APP_ID_PATTERN,
  APP_MANIFEST_FILE_NAME,
  APP_MANIFEST_VERSION,
  parseAppManifest,
  type RivrAppManifest,
} from "@/lib/builder/app-manifest";
import { queueAppLifecycleRequest } from "@/lib/builder/app-lifecycle";
import { validateSitePath } from "@/lib/builder/assistant-tools";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export class SiteAppBridgeError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "SiteAppBridgeError";
    this.statusCode = statusCode;
  }
}

/** Builds the static-app manifest for a deployed site environment. */
export function buildSiteAppManifest(appId: string, name: string): RivrAppManifest {
  const manifest = parseAppManifest({
    version: APP_MANIFEST_VERSION,
    appId,
    name,
    runtime: "static",
    resourceClass: "tiny",
    database: "none",
    secretNames: [],
    healthPath: "/",
  });
  if (!manifest.ok) {
    throw new SiteAppBridgeError(
      `Internal manifest error: ${manifest.errors.join("; ")}`,
      500,
    );
  }
  return manifest.manifest;
}

/**
 * Writes the site files + manifest into the app workspace `<root>/<appId>/`
 * and queues a broker `deploy`. Existing workspace contents are replaced by
 * the new snapshot (stale files from a previous deploy are removed) so the
 * environment always matches the published site exactly.
 *
 * @returns The queued request id and the workspace file count.
 */
export async function deploySiteAsApp(
  appId: string,
  name: string,
  files: SiteFiles,
): Promise<{ appId: string; requestId: string; fileCount: number }> {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new SiteAppBridgeError(
      "App id must be 2–32 chars: lowercase letters, digits, dashes (no leading/trailing dash).",
    );
  }
  const entries = Object.entries(files ?? {});
  if (entries.length === 0) {
    throw new SiteAppBridgeError("Nothing to deploy — the site workspace is empty.");
  }
  if (!("index.html" in files)) {
    throw new SiteAppBridgeError("The site needs an index.html to deploy.");
  }
  for (const [filePath] of entries) {
    const pathError = validateSitePath(filePath);
    if (pathError) throw new SiteAppBridgeError(`${filePath}: ${pathError}`);
  }

  const manifest = buildSiteAppManifest(appId, name);
  const workspaceDir = path.join(getAgentAppWorkspaceRoot(), appId);

  // Refuse to clobber a NON-site app workspace (one whose manifest isn't a
  // static site deploy) — the bridge only manages workspaces it created.
  const manifestPath = path.join(workspaceDir, APP_MANIFEST_FILE_NAME);
  if (existsSync(workspaceDir) && existsSync(manifestPath)) {
    const { readFile } = await import("node:fs/promises");
    try {
      const existing = parseAppManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      if (existing.ok && existing.manifest.runtime !== "static") {
        throw new SiteAppBridgeError(
          `App "${appId}" exists with runtime "${existing.manifest.runtime}" — pick a different id.`,
          409,
        );
      }
    } catch (error) {
      if (error instanceof SiteAppBridgeError) throw error;
      // Unreadable manifest — treat as replaceable site workspace.
    }
  }

  await mkdir(workspaceDir, { recursive: true, mode: 0o755 });

  // Remove stale top-level files from a previous snapshot (flat + subdir site
  // files only — never anything outside the workspace).
  const keep = new Set([APP_MANIFEST_FILE_NAME, ...Object.keys(files)]);
  const current = await readdir(workspaceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of current) {
    if (entry.isFile() && !keep.has(entry.name)) {
      await unlink(path.join(workspaceDir, entry.name)).catch(() => {});
    }
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  for (const [filePath, content] of entries) {
    const target = path.join(workspaceDir, filePath);
    if (!target.startsWith(workspaceDir + path.sep)) continue;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    await writeFile(target, content, { encoding: "utf8", mode: 0o644 });
  }

  // queueAppLifecycleRequest re-reads + re-validates the manifest we just
  // wrote (the broker contract's own deploy path — no bypass).
  const request = await queueAppLifecycleRequest({ appId, action: "deploy" });

  return { appId, requestId: request.requestId, fileCount: entries.length };
}
