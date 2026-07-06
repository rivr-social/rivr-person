import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let workspaceRoot = "";
vi.mock("@/lib/agent-hq", () => ({
  getAgentAppWorkspaceRoot: () => workspaceRoot,
}));

import {
  APP_MAX_CUSTOM_DOMAINS,
  attachAppDomain,
  detachAppDomain,
  normalizeCustomDomain,
  readAppDomains,
} from "@/lib/builder/app-domains";
import { AppLifecycleError } from "@/lib/builder/app-lifecycle";

let sandbox = "";

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "rivr-app-domains-"));
  workspaceRoot = path.join(sandbox, "apps");
  await mkdir(workspaceRoot, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

describe("normalizeCustomDomain", () => {
  it("normalizes case, port, and trailing dot", () => {
    expect(normalizeCustomDomain("Example.COM:443")).toBe("example.com");
    expect(normalizeCustomDomain("sub.example.com.")).toBe("sub.example.com");
  });

  it("rejects wildcards, bare TLDs, and junk", () => {
    for (const bad of ["*.example.com", "example", "http://x.com/path", "a b.com", ""]) {
      expect(normalizeCustomDomain(bad)).toBeNull();
    }
  });
});

describe("attach/detach/read app domains", () => {
  it("persists attached domains and reads them back", async () => {
    await attachAppDomain("demo-app", "one.example.com");
    const domains = await attachAppDomain("demo-app", "Two.Example.com");
    expect(domains).toEqual(["one.example.com", "two.example.com"]);
    expect(await readAppDomains("demo-app")).toEqual([
      "one.example.com",
      "two.example.com",
    ]);
  });

  it("is idempotent for an already-attached domain", async () => {
    await attachAppDomain("demo-app", "one.example.com");
    const domains = await attachAppDomain("demo-app", "one.example.com");
    expect(domains).toEqual(["one.example.com"]);
  });

  it("caps custom domains per app", async () => {
    for (let i = 0; i < APP_MAX_CUSTOM_DOMAINS; i += 1) {
      await attachAppDomain("demo-app", `d${i}.example.com`);
    }
    await expect(
      attachAppDomain("demo-app", "overflow.example.com"),
    ).rejects.toThrow(/capped/);
  });

  it("detaches a domain and leaves the rest", async () => {
    await attachAppDomain("demo-app", "one.example.com");
    await attachAppDomain("demo-app", "two.example.com");
    const domains = await detachAppDomain("demo-app", "one.example.com");
    expect(domains).toEqual(["two.example.com"]);
  });

  it("returns [] for an app with no domains file", async () => {
    expect(await readAppDomains("fresh-app")).toEqual([]);
  });

  it("rejects invalid app ids and domains", async () => {
    await expect(attachAppDomain("../etc", "x.example.com")).rejects.toThrow(
      AppLifecycleError,
    );
    await expect(attachAppDomain("demo-app", "not a domain")).rejects.toThrow(
      /Invalid domain/,
    );
  });
});
