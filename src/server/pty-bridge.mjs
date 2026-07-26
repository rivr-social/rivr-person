/**
 * PTY Bridge Server
 *
 * Standalone WebSocket server that provides real interactive terminal sessions
 * by bridging browser WebSocket connections to node-pty pseudo-terminals.
 *
 * Attaches an authenticated client to an existing tmux session. Session
 * creation and command selection remain behind the owner-gated Next.js API.
 *
 * Environment variables:
 *   PTY_BRIDGE_PORT           - listen port (default 3100)
 *   AGENT_HQ_SESSION_SECRET   - required bearer token
 *   PTY_BRIDGE_HOST           - listen host (default 127.0.0.1)
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";

// node-pty ships a native addon that cannot be loaded via ESM import.
// Use createRequire so Node resolves it through the CommonJS loader.
const require = createRequire(import.meta.url);
const pty = require("node-pty");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 3100;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const HEALTH_OK_STATUS = 200;
const HTTP_BAD_REQUEST_STATUS = 400;
const HTTP_UNAUTHORIZED_STATUS = 401;
const HTTP_NOT_FOUND_STATUS = 404;
const UPGRADE_REQUIRED_STATUS = 426;
const WS_POLICY_VIOLATION = 1008;
const WS_INTERNAL_ERROR = 1011;
const MAX_MESSAGE_BYTES = 64 * 1024;

const PTY_BRIDGE_PORT = parseInt(process.env.PTY_BRIDGE_PORT ?? String(DEFAULT_PORT), 10);
const PTY_BRIDGE_HOST = process.env.PTY_BRIDGE_HOST?.trim() || "127.0.0.1";

function readSessionSecret() {
  const direct = process.env.AGENT_HQ_SESSION_SECRET?.trim();
  if (direct) return direct;
  const file = process.env.AGENT_HQ_SESSION_SECRET_FILE?.trim();
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const SESSION_SECRET = readSessionSecret();
if (!SESSION_SECRET) {
  throw new Error(
    "AGENT_HQ_SESSION_SECRET or AGENT_HQ_SESSION_SECRET_FILE is required",
  );
}

function parseDimension(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? String(fallback), 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function log(msg) {
  const ts = new Date().toISOString();
  process.stdout.write(`[pty-bridge ${ts}] ${msg}\n`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  process.stderr.write(`[pty-bridge ${ts}] ERROR: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function isAuthorized(req) {
  const headerToken = req.headers["x-session-token"];
  if (typeof headerToken !== "string") return false;
  const received = Buffer.from(headerToken);
  const expected = Buffer.from(SESSION_SECRET);
  return (
    received.length === expected.length &&
    timingSafeEqual(received, expected)
  );
}

// ---------------------------------------------------------------------------
// HTTP server (health endpoint + WebSocket upgrade)
// ---------------------------------------------------------------------------

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/health" || url.pathname === "/ws/health") {
    res.writeHead(HEALTH_OK_STATUS, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "pty-bridge" }));
    return;
  }

  // All other non-upgrade HTTP requests get a simple message.
  res.writeHead(UPGRADE_REQUIRED_STATUS, { "Content-Type": "text/plain" });
  res.end("WebSocket upgrade required. Connect via ws://host:port/terminal");
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

// Track active sessions for graceful shutdown
const activeSessions = new Set();

httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname !== "/terminal" && url.pathname !== "/ws/terminal") {
    socket.write(`HTTP/1.1 ${HTTP_NOT_FOUND_STATUS} Not Found\r\n\r\n`);
    socket.destroy();
    return;
  }

  if (!isAuthorized(req)) {
    socket.write(`HTTP/1.1 ${HTTP_UNAUTHORIZED_STATUS} Unauthorized\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const paneKey = url.searchParams.get("pane");
  const cols = parseDimension(url.searchParams.get("cols"), DEFAULT_COLS, 20, 400);
  const rows = parseDimension(url.searchParams.get("rows"), DEFAULT_ROWS, 5, 200);

  if (!paneKey || !/^[a-zA-Z0-9_.-]{1,128}:\d+\.\d+$/.test(paneKey)) {
    ws.close(WS_POLICY_VIOLATION, "Invalid tmux pane target");
    return;
  }

  const sessionTarget = paneKey.split(":")[0];
  const shell = "tmux";
  const args = ["attach-session", "-t", sessionTarget];
  log(`Attach session: pane=${paneKey} session=${sessionTarget} cols=${cols} rows=${rows}`);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.env.HOME || "/",
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });
  } catch (err) {
    logError(`Failed to spawn pty: ${err.message}`);
    ws.close(WS_INTERNAL_ERROR, `Failed to spawn: ${err.message}`);
    return;
  }

  const sessionId = ptyProcess.pid;
  activeSessions.add(sessionId);
  log(`PTY spawned pid=${sessionId}`);

  // PTY stdout -> WebSocket (binary frames)
  ptyProcess.onData((data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data, { binary: false });
    }
  });

  // PTY exit -> close WebSocket
  ptyProcess.onExit(({ exitCode, signal }) => {
    log(`PTY exited pid=${sessionId} code=${exitCode} signal=${signal}`);
    activeSessions.delete(sessionId);
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close();
    }
  });

  // WebSocket messages -> PTY stdin (or resize)
  ws.on("message", (data) => {
    if (data.length > MAX_MESSAGE_BYTES) {
      ws.close(WS_POLICY_VIOLATION, "Terminal message is too large");
      return;
    }
    const msg = typeof data === "string" ? data : data.toString("utf-8");

    // Check for JSON control messages
    if (msg.startsWith("{")) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
          ptyProcess.resize(parsed.cols, parsed.rows);
          return;
        }
      } catch {
        // Not valid JSON — treat as regular input
      }
    }

    // Regular terminal input
    ptyProcess.write(msg);
  });

  // WebSocket close -> kill PTY
  ws.on("close", () => {
    log(`WebSocket closed for pid=${sessionId}`);
    activeSessions.delete(sessionId);
    try {
      ptyProcess.kill();
    } catch {
      // Already dead
    }
  });

  ws.on("error", (err) => {
    logError(`WebSocket error pid=${sessionId}: ${err.message}`);
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PTY_BRIDGE_PORT, PTY_BRIDGE_HOST, () => {
  log(`Listening on ${PTY_BRIDGE_HOST}:${PTY_BRIDGE_PORT}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  log(`Received ${signal}, shutting down...`);

  // Close all active WebSocket connections
  wss.clients.forEach((client) => {
    client.close();
  });

  httpServer.close(() => {
    log("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  const SHUTDOWN_TIMEOUT_MS = 5000;
  setTimeout(() => {
    logError("Forced exit after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
