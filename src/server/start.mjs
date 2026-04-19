/**
 * Dual-server startup wrapper
 *
 * Launches the Next.js standalone server and the PTY bridge server as child
 * processes, piping their output to the parent. Exits when either child exits
 * and forwards SIGTERM/SIGINT for graceful shutdown.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHUTDOWN_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Resolve paths relative to repo/container root
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// In the Docker standalone build, layout is:
//   /app/server.js          (Next.js standalone)
//   /app/src/server/start.mjs   (this file)
//   /app/src/server/pty-bridge.mjs
const appRoot = join(__dirname, "..", "..");
const nextServerPath = join(appRoot, "server.js");
const ptyBridgePath = join(__dirname, "pty-bridge.mjs");

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[start ${ts}] ${msg}\n`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[start ${ts}] ERROR: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Spawn children
// ---------------------------------------------------------------------------

log(`Starting Next.js server: ${nextServerPath}`);
const nextProc = spawn("node", [nextServerPath], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
  cwd: appRoot,
});

log(`Starting PTY bridge: ${ptyBridgePath}`);
const ptyProc = spawn("node", [ptyBridgePath], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
  cwd: appRoot,
});

// ---------------------------------------------------------------------------
// Child exit handling — exit when either child dies
// ---------------------------------------------------------------------------

let exiting = false;

function handleChildExit(name, code, signal) {
  log(`${name} exited code=${code} signal=${signal}`);
  if (!exiting) {
    exiting = true;
    cleanup(code ?? 1);
  }
}

nextProc.on("exit", (code, signal) => handleChildExit("next", code, signal));
ptyProc.on("exit", (code, signal) => handleChildExit("pty-bridge", code, signal));

nextProc.on("error", (err) => {
  logError(`next spawn error: ${err.message}`);
  if (!exiting) {
    exiting = true;
    cleanup(1);
  }
});

ptyProc.on("error", (err) => {
  logError(`pty-bridge spawn error: ${err.message}`);
  if (!exiting) {
    exiting = true;
    cleanup(1);
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function cleanup(exitCode) {
  log("Shutting down children...");

  // Send SIGTERM to both
  try { nextProc.kill("SIGTERM"); } catch { /* already dead */ }
  try { ptyProc.kill("SIGTERM"); } catch { /* already dead */ }

  // Force kill after timeout
  setTimeout(() => {
    logError("Forced exit after timeout");
    try { nextProc.kill("SIGKILL"); } catch { /* ignore */ }
    try { ptyProc.kill("SIGKILL"); } catch { /* ignore */ }
    process.exit(exitCode);
  }, SHUTDOWN_TIMEOUT_MS);

  // Wait for both children to finish, then exit
  let nextDone = false;
  let ptyDone = false;

  function checkDone() {
    if (nextDone && ptyDone) {
      process.exit(exitCode);
    }
  }

  nextProc.on("exit", () => { nextDone = true; checkDone(); });
  ptyProc.on("exit", () => { ptyDone = true; checkDone(); });

  // If they already exited before we attached these listeners
  if (nextProc.exitCode !== null) { nextDone = true; }
  if (ptyProc.exitCode !== null) { ptyDone = true; }
  checkDone();
}

function onSignal(signal) {
  log(`Received ${signal}`);
  if (!exiting) {
    exiting = true;
    cleanup(0);
  }
}

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
