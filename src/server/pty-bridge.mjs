/**
 * PTY Bridge Server
 *
 * Standalone WebSocket server that provides real interactive terminal sessions
 * by bridging browser WebSocket connections to node-pty pseudo-terminals.
 *
 * Supports two modes:
 *   1. Attach to an existing tmux pane:  ws://host:PORT/terminal?pane=<tmuxPaneKey>
 *   2. Spawn a new command directly:     ws://host:PORT/terminal?new=1&cmd=<command>&cwd=<dir>
 *
 * Environment variables:
 *   PTY_BRIDGE_PORT           - listen port (default 3100)
 *   AGENT_HQ_SESSION_SECRET   - optional auth token; when set, clients must provide it
 */

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

const PTY_BRIDGE_PORT = parseInt(process.env.PTY_BRIDGE_PORT ?? String(DEFAULT_PORT), 10);
const SESSION_SECRET = process.env.AGENT_HQ_SESSION_SECRET ?? "";

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
  if (!SESSION_SECRET) return true;

  const headerToken = req.headers["x-session-token"];
  if (headerToken === SESSION_SECRET) return true;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get("token");
  if (queryToken === SESSION_SECRET) return true;

  return false;
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
  const isNew = url.searchParams.get("new") === "1";
  const cmd = url.searchParams.get("cmd") || "bash";
  const cwd = url.searchParams.get("cwd") || process.env.HOME || "/";
  const cols = parseInt(url.searchParams.get("cols") ?? String(DEFAULT_COLS), 10);
  const rows = parseInt(url.searchParams.get("rows") ?? String(DEFAULT_ROWS), 10);

  if (!paneKey && !isNew) {
    ws.close(WS_POLICY_VIOLATION, "Missing pane or new parameter");
    return;
  }

  let shell;
  let args;

  if (isNew) {
    // Spawn the command directly via node-pty (no tmux)
    shell = cmd;
    args = [];
    log(`New session: cmd=${cmd} cwd=${cwd} cols=${cols} rows=${rows}`);
  } else {
    // Attach to the tmux session that owns the requested pane. `attach-session`
    // does not accept a `session:window.pane` target, only a session/client target.
    const sessionTarget = paneKey.startsWith("%") ? null : paneKey.split(":")[0];
    if (!sessionTarget) {
      ws.close(WS_POLICY_VIOLATION, "Unsupported pane target");
      return;
    }
    shell = "tmux";
    args = ["attach-session", "-t", sessionTarget];
    log(`Attach session: pane=${paneKey} session=${sessionTarget} cols=${cols} rows=${rows}`);
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: isNew ? cwd : process.env.HOME || "/",
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

httpServer.listen(PTY_BRIDGE_PORT, "0.0.0.0", () => {
  log(`Listening on 0.0.0.0:${PTY_BRIDGE_PORT}`);
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
