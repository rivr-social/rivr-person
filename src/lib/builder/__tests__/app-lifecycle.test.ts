import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The lifecycle module resolves everything from the agent-hq app workspace
// root; point it at a throwaway directory per test run.
let workspaceRoot = "";
vi.mock("@/lib/agent-hq", () => ({
  getAgentAppWorkspaceRoot: () => workspaceRoot,
}));

import {
  AppLifecycleError,
  appQueueDir,
  appStatusDir,
  hasPendingRequest,
  queueAppLifecycleRequest,
  readAppManifest,
  readAppStatus,
} from "@/lib/builder/app-lifecycle";
import { APP_MANIFEST_FILE_NAME, APP_MANIFEST_VERSION } from "@/lib/builder/app-manifest";

const VALID_MANIFEST = {
  version: APP_MANIFEST_VERSION,
  appId: "demo-app",
  name: "Demo",
  runtime: "static",
  resourceClass: "tiny",
  database: "none",
  secretNames: [],
  healthPath: "/",
};

let sandbox = "";

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "rivr-app-lifecycle-"));
  workspaceRoot = path.join(sandbox, "apps");
  await mkdir(path.join(workspaceRoot, "demo-app"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, "demo-app", APP_MANIFEST_FILE_NAME),
    JSON.stringify(VALID_MANIFEST),
    "utf8",
  );
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

describe("readAppManifest", () => {
  it("reads a valid manifest from the workspace", async () => {
    const result = await readAppManifest("demo-app");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.appId).toBe("demo-app");
  });

  it("reports a missing manifest without throwing", async () => {
    await mkdir(path.join(workspaceRoot, "other-app"), { recursive: true });
    const result = await readAppManifest("other-app");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("not found");
  });

  it("rejects a manifest whose appId mismatches the workspace", async () => {
    await mkdir(path.join(workspaceRoot, "wrong-home"), { recursive: true });
    await writeFile(
      path.join(workspaceRoot, "wrong-home", APP_MANIFEST_FILE_NAME),
      JSON.stringify(VALID_MANIFEST),
      "utf8",
    );
    const result = await readAppManifest("wrong-home");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("does not match workspace");
  });

  it("rejects invalid JSON", async () => {
    await writeFile(
      path.join(workspaceRoot, "demo-app", APP_MANIFEST_FILE_NAME),
      "{not json",
      "utf8",
    );
    const result = await readAppManifest("demo-app");
    expect(result.ok).toBe(false);
  });

  it("throws on malformed app ids before touching the filesystem", async () => {
    await expect(readAppManifest("../escape")).rejects.toThrow(AppLifecycleError);
  });
});

// ---------------------------------------------------------------------------
// Request queueing
// ---------------------------------------------------------------------------

describe("queueAppLifecycleRequest", () => {
  it("writes a typed deploy request with the validated manifest embedded", async () => {
    const request = await queueAppLifecycleRequest({ appId: "demo-app", action: "deploy" });
    expect(request.action).toBe("deploy");
    expect(request.manifest?.appId).toBe("demo-app");

    const spooled = JSON.parse(
      await readFile(path.join(appQueueDir(), "demo-app.json"), "utf8"),
    );
    expect(spooled.requestId).toBe(request.requestId);
    expect(spooled.manifest.runtime).toBe("static");
  });

  it("refuses deploy when the manifest is invalid", async () => {
    await writeFile(
      path.join(workspaceRoot, "demo-app", APP_MANIFEST_FILE_NAME),
      JSON.stringify({ ...VALID_MANIFEST, runtime: "php" }),
      "utf8",
    );
    await expect(
      queueAppLifecycleRequest({ appId: "demo-app", action: "deploy" }),
    ).rejects.toThrow(/Manifest invalid/);
  });

  it("supersedes a pending request for the same app (one spool slot per app)", async () => {
    await queueAppLifecycleRequest({ appId: "demo-app", action: "deploy" });
    const second = await queueAppLifecycleRequest({ appId: "demo-app", action: "stop" });
    const entries = await readdir(appQueueDir());
    expect(entries).toEqual(["demo-app.json"]);
    const spooled = JSON.parse(
      await readFile(path.join(appQueueDir(), "demo-app.json"), "utf8"),
    );
    expect(spooled.requestId).toBe(second.requestId);
    expect(spooled.action).toBe("stop");
  });

  it("requires the appId echo as confirmToken for delete", async () => {
    await expect(
      queueAppLifecycleRequest({ appId: "demo-app", action: "delete" }),
    ).rejects.toThrow(/confirmToken/);
    await expect(
      queueAppLifecycleRequest({
        appId: "demo-app",
        action: "delete",
        confirmToken: "wrong",
      }),
    ).rejects.toThrow(/confirmToken/);
    const request = await queueAppLifecycleRequest({
      appId: "demo-app",
      action: "delete",
      confirmToken: "demo-app",
    });
    expect(request.confirmToken).toBe("demo-app");
  });

  it("rejects unknown actions", async () => {
    await expect(
      queueAppLifecycleRequest({
        appId: "demo-app",
        action: "exec" as never,
      }),
    ).rejects.toThrow(AppLifecycleError);
  });
});

// ---------------------------------------------------------------------------
// Status + pending
// ---------------------------------------------------------------------------

describe("readAppStatus / hasPendingRequest", () => {
  it("returns null status and no pending work for an untouched app", async () => {
    expect(await readAppStatus("demo-app")).toBeNull();
    expect(await hasPendingRequest("demo-app")).toBe(false);
  });

  it("reads broker-written status and detects a pending spool entry", async () => {
    await queueAppLifecycleRequest({ appId: "demo-app", action: "deploy" });
    expect(await hasPendingRequest("demo-app")).toBe(true);

    await mkdir(appStatusDir(), { recursive: true });
    await writeFile(
      path.join(appStatusDir(), "demo-app.json"),
      JSON.stringify({ version: 1, appId: "demo-app", phase: "running", release: "r1" }),
      "utf8",
    );
    const status = await readAppStatus("demo-app");
    expect(status?.phase).toBe("running");
    expect(status?.release).toBe("r1");
  });
});
