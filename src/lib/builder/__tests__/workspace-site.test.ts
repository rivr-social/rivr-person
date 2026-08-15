import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/agent-hq", () => ({
  discoverAgentProjects: vi.fn(async () => []),
}));

import type { AgentWorkspace } from "@/lib/agent-hq";
import {
  queueWorkspaceDeployment,
  resolveWorkspaceWriteRoot,
  writeWorkspaceSiteFiles,
} from "@/lib/builder/workspace-site";

const tempDirectories: string[] = [];

async function workspace(): Promise<AgentWorkspace> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "rivr-builder-workspace-"));
  tempDirectories.push(cwd);
  return {
    id: "app-test",
    name: "test",
    label: "Test app",
    cwd,
    scope: "app",
    description: "test",
    deployRoot: "/opt/test",
    liveSubdomain: "test.example.com",
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("workspace site service", () => {
  it("writes only jailed, allowlisted text files", async () => {
    const target = await workspace();
    const result = await writeWorkspaceSiteFiles(
      target,
      { "index.html": "<h1>Hello</h1>", "assets/style.css": "body { color: red; }" },
      "public",
    );
    expect(result.filesWritten).toBe(2);
    expect(await readFile(path.join(target.cwd, "public/index.html"), "utf8")).toBe(
      "<h1>Hello</h1>",
    );
    expect(await readFile(path.join(target.cwd, "public/assets/style.css"), "utf8")).toBe(
      "body { color: red; }",
    );
    await expect(
      writeWorkspaceSiteFiles(target, { "../outside.css": "nope" }),
    ).rejects.toThrow(/escapes/i);
    await expect(
      writeWorkspaceSiteFiles(target, { "deploy.sh": "nope" }),
    ).rejects.toThrow(/unsupported/i);
    expect(() => resolveWorkspaceWriteRoot(target, "../outside")).toThrow(/escapes/i);
  });

  it("queues an atomic request whose digest reflects workspace contents", async () => {
    const target = await workspace();
    await writeWorkspaceSiteFiles(target, { "index.html": "first" });
    const first = await queueWorkspaceDeployment(target);
    const stored = JSON.parse(
      await readFile(path.join(target.cwd, ".rivr-deploy/request.json"), "utf8"),
    ) as typeof first;
    expect(stored).toEqual(first);

    await writeWorkspaceSiteFiles(target, { "index.html": "second" });
    const second = await queueWorkspaceDeployment(target);
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
  });
});
