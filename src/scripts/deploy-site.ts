#!/usr/bin/env tsx
/**
 * deploy-site.ts
 *
 * Standalone deploy script that:
 * 1. Fetches the generated multi-page site from /api/bespoke/generate-site
 * 2. Writes files to the target host via SCP/SSH
 *
 * Usage:
 *   npx tsx src/scripts/deploy-site.ts [options]
 *
 * Environment variables:
 *   BESPOKE_API_URL        - Base URL of the Rivr instance (default: http://localhost:3000)
 *   BESPOKE_AUTH_COOKIE     - Session cookie value for authentication
 *   BESPOKE_DEPLOY_HOST     - SSH host to deploy to (default: 5.161.46.237)
 *   BESPOKE_DEPLOY_USER     - SSH user (default: root)
 *   BESPOKE_DEPLOY_PATH     - Remote directory path (default: /opt/camalot)
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE_URL = process.env.BESPOKE_API_URL || "http://localhost:3000";
const AUTH_COOKIE = process.env.BESPOKE_AUTH_COOKIE || "";
const DEPLOY_HOST = process.env.BESPOKE_DEPLOY_HOST || "5.161.46.237";
const DEPLOY_USER = process.env.BESPOKE_DEPLOY_USER || "root";
const DEPLOY_PATH = process.env.BESPOKE_DEPLOY_PATH || "/opt/camalot";

const GENERATE_ENDPOINT = "/api/bespoke/generate-site";

const EXIT_CODE_SUCCESS = 0;
const EXIT_CODE_AUTH_MISSING = 1;
const EXIT_CODE_GENERATE_FAILED = 2;
const EXIT_CODE_DEPLOY_FAILED = 3;

const SSH_TIMEOUT_MS = 10_000;
const SCP_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

function logError(message: string): void {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ERROR: ${message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Rivr Bespoke Site Deploy Script");
  log(`API: ${API_BASE_URL}`);
  log(`Target: ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}`);

  if (!AUTH_COOKIE) {
    logError("BESPOKE_AUTH_COOKIE is required. Set it to your session cookie value.");
    logError("You can find this in your browser's dev tools under Application > Cookies.");
    process.exit(EXIT_CODE_AUTH_MISSING);
  }

  // Step 1: Fetch generated site from the API
  log("Fetching generated site from API...");

  let files: Record<string, string>;
  let pages: string[];

  try {
    const response = await fetch(`${API_BASE_URL}${GENERATE_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `authjs.session-token=${AUTH_COOKIE}`,
      },
      body: JSON.stringify({
        // The API endpoint fetches its own bundle; we send minimal preferences
        // For the deploy script, we pass preferences that match the desired output
        preferences: {
          preset: process.env.BESPOKE_THEME || "default",
          visibleSections: [],
          siteTitle: process.env.BESPOKE_SITE_TITLE || "",
          instanceType: "person",
        },
      }),
    });

    const data = (await response.json()) as {
      success: boolean;
      files?: Record<string, string>;
      pages?: string[];
      error?: string;
    };

    if (!response.ok || !data.success) {
      throw new Error(data.error || `API returned ${response.status}`);
    }

    if (!data.files || !data.pages) {
      throw new Error("API response missing files or pages");
    }

    files = data.files;
    pages = data.pages;
    log(`Generated ${Object.keys(files).length} files: ${pages.join(", ")}`);
  } catch (error) {
    logError(`Failed to generate site: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CODE_GENERATE_FAILED);
  }

  // Step 2: Write files to a temporary directory
  const tmpDir = join(tmpdir(), `rivr-deploy-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  log(`Writing files to temp directory: ${tmpDir}`);

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(tmpDir, filePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content, "utf-8");
  }

  // Step 3: SCP files to the remote host
  log(`Deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}...`);

  try {
    // Ensure remote directory exists
    execSync(
      `ssh ${DEPLOY_USER}@${DEPLOY_HOST} "mkdir -p ${DEPLOY_PATH}"`,
      { timeout: SSH_TIMEOUT_MS, stdio: "pipe" },
    );

    // rsync the temp directory contents to the remote path
    execSync(
      `rsync -avz --delete ${tmpDir}/ ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/`,
      { timeout: SCP_TIMEOUT_MS, stdio: "inherit" },
    );

    log("Deploy complete.");
  } catch (error) {
    logError(`Deploy failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_CODE_DEPLOY_FAILED);
  } finally {
    // Clean up temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-critical
    }
  }

  // Step 4: Verify
  log("Verifying deployment...");
  try {
    const verifyResult = execSync(
      `ssh ${DEPLOY_USER}@${DEPLOY_HOST} "ls -la ${DEPLOY_PATH}/"`,
      { timeout: SSH_TIMEOUT_MS, encoding: "utf-8" },
    );
    log("Remote directory listing:");
    console.log(verifyResult);
  } catch {
    log("Could not verify remote directory (non-critical).");
  }

  log(`Deployment successful. ${Object.keys(files).length} files written to ${DEPLOY_PATH}`);
  log("Site should be live at the configured nginx domain.");
  process.exit(EXIT_CODE_SUCCESS);
}

main().catch((error) => {
  logError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_CODE_DEPLOY_FAILED);
});
