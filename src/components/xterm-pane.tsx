"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import type { Terminal as XTermTerminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

export interface XTermPaneHandle {
  writeRaw: (data: string) => void;
  clear: () => void;
  fit: () => void;
  getTerminal: () => XTermTerminal | null;
}

interface XTermPaneProps {
  maxHeight: string;
  active?: boolean;
  onInput?: (data: string) => void;
  /** WebSocket URL for real-time interactive terminal I/O. When provided, polling-based I/O is bypassed. */
  wsUrl?: string;
  /** Called when the WebSocket connection opens. */
  onWsOpen?: () => void;
  /** Called when the WebSocket connection closes. */
  onWsClose?: () => void;
  /** Called with every chunk of output data received from the WebSocket. */
  onWsData?: (data: string) => void;
}

const THEME = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#3b82f650",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d2c0",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

const FONT_FAMILY = "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace";

const WS_MAX_RECONNECT_ATTEMPTS = 20;
const WS_RECONNECT_DELAY_MS = 2000;

/**
 * Real xterm.js terminal pane that replaces the faux <pre>-based terminal.
 * Dynamically imports xterm to avoid SSR issues with Next.js.
 *
 * Supports two I/O modes:
 * 1. Polling mode (default): external code calls writeRaw/clear via ref; onInput relays keystrokes.
 * 2. WebSocket mode (when wsUrl is provided): connects to a PTY bridge for real-time interactive I/O.
 */
const XTermPane = forwardRef<XTermPaneHandle, XTermPaneProps>(function XTermPane(
  { maxHeight, active, onInput, wsUrl, onWsOpen, onWsClose, onWsData },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastWrittenRef = useRef<string>("");
  const initRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const wsReconnectAttemptsRef = useRef(0);
  const wsReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Stable refs for callbacks to avoid re-init cycles
  const onWsOpenRef = useRef(onWsOpen);
  const onWsCloseRef = useRef(onWsClose);
  const onWsDataRef = useRef(onWsData);
  const wsUrlRef = useRef(wsUrl);

  // Keep callback refs current
  useEffect(() => { onWsOpenRef.current = onWsOpen; }, [onWsOpen]);
  useEffect(() => { onWsCloseRef.current = onWsClose; }, [onWsClose]);
  useEffect(() => { onWsDataRef.current = onWsData; }, [onWsData]);
  useEffect(() => { wsUrlRef.current = wsUrl; }, [wsUrl]);

  const isWsMode = Boolean(wsUrl);

  useImperativeHandle(ref, () => ({
    writeRaw(data: string) {
      const term = termRef.current;
      if (!term) return;
      // Diff against last written to avoid full rewrite flicker on polls
      if (data === lastWrittenRef.current) return;
      lastWrittenRef.current = data;
      term.reset();
      // Write line-by-line to handle ANSI sequences properly
      const lines = data.split("\n");
      for (let i = 0; i < lines.length; i++) {
        term.write(lines[i]);
        if (i < lines.length - 1) term.write("\r\n");
      }
      // Scroll to bottom
      term.scrollToBottom();
    },
    clear() {
      termRef.current?.reset();
      lastWrittenRef.current = "";
    },
    fit() {
      fitAddonRef.current?.fit();
    },
    getTerminal() {
      return termRef.current;
    },
  }));

  const connectWebSocket = useCallback((term: XTermTerminal, url: string) => {
    // Close any existing connection
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* noop */ }
      wsRef.current = null;
    }

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      wsReconnectAttemptsRef.current = 0;
      term.options.cursorBlink = true;
      onWsOpenRef.current?.();

      // Send initial resize so the PTY bridge knows our dimensions
      if (term.cols && term.rows) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      const data = typeof event.data === "string" ? event.data : "";
      if (data) {
        term.write(data);
        onWsDataRef.current?.(data);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      onWsCloseRef.current?.();
      term.write("\r\n\x1b[33m[Connection closed]\x1b[0m\r\n");

      // Attempt reconnect if we haven't exhausted retries and the wsUrl is still set
      if (
        wsReconnectAttemptsRef.current < WS_MAX_RECONNECT_ATTEMPTS &&
        wsUrlRef.current
      ) {
        wsReconnectAttemptsRef.current++;
        term.write(`\x1b[90m[Reconnecting... attempt ${wsReconnectAttemptsRef.current}/${WS_MAX_RECONNECT_ATTEMPTS}]\x1b[0m\r\n`);
        wsReconnectTimerRef.current = setTimeout(() => {
          if (wsUrlRef.current && termRef.current) {
            connectWebSocket(termRef.current, wsUrlRef.current);
          }
        }, WS_RECONNECT_DELAY_MS);
      }
    };

    ws.onerror = () => {
      term.write("\r\n\x1b[31m[WebSocket error]\x1b[0m\r\n");
      // onclose will fire after onerror, handling reconnect there
    };

    // Wire keystrokes to WebSocket
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });
  }, []);

  const initTerminal = useCallback(async () => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]);

    // CSS is imported globally via layout.tsx (@xterm/xterm/css/xterm.css)

    const useWs = Boolean(wsUrlRef.current);

    const term = new Terminal({
      theme: THEME,
      fontFamily: FONT_FAMILY,
      fontSize: 11,
      lineHeight: 1.6,
      cursorBlink: active ?? false,
      cursorStyle: "block",
      disableStdin: useWs ? false : !onInput,
      convertEol: false,
      scrollback: 2000,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    // In polling mode, wire onInput for keystrokes
    if (!useWs && onInput) {
      term.onData(onInput);
    }

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // In WebSocket mode, connect after terminal is ready
    if (useWs && wsUrlRef.current) {
      connectWebSocket(term, wsUrlRef.current);
    }
  }, [active, onInput, connectWebSocket]);

  useEffect(() => {
    void initTerminal();
    return () => {
      // Cleanup reconnect timer
      if (wsReconnectTimerRef.current) {
        clearTimeout(wsReconnectTimerRef.current);
        wsReconnectTimerRef.current = null;
      }
      // Close WebSocket
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* noop */ }
        wsRef.current = null;
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      initRef.current = false;
    };
  }, [initTerminal]);

  // Handle wsUrl changes after initial mount (reconnect to new URL or disconnect)
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (wsUrl) {
      // If we already have a WS connected to a different URL, reconnect
      connectWebSocket(term, wsUrl);
      // Enable interactive mode
      term.options.disableStdin = false;
    } else {
      // wsUrl was cleared — close WS and revert to polling mode
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { /* noop */ }
        wsRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  // Reconnect WebSocket when tab becomes visible again (mobile browsers suspend tabs)
  useEffect(() => {
    if (!wsUrl) return;
    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      const ws = wsRef.current;
      const term = termRef.current;
      if (!term || !wsUrlRef.current) return;
      // If WS is closed or closing, reset attempts and reconnect
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        wsReconnectAttemptsRef.current = 0;
        term.write("\r\n\x1b[90m[Reconnecting...]\x1b[0m\r\n");
        connectWebSocket(term, wsUrlRef.current);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [wsUrl, connectWebSocket]);

  // Send resize events over WS when the terminal is re-fitted
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const fitAddon = fitAddonRef.current;
      if (fitAddon) {
        fitAddon.fit();
      }
      // Notify PTY bridge of new dimensions
      const term = termRef.current;
      const ws = wsRef.current;
      if (term && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Mobile paste helper: invisible textarea that captures paste and keyboard input
  const mobileInputRef = useRef<HTMLTextAreaElement>(null);
  const handleMobilePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    if (text && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(text);
      e.preventDefault();
    }
    // Clear the textarea after paste
    if (mobileInputRef.current) mobileInputRef.current.value = "";
  }, []);

  const handleMobileKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (e.key === "Enter") {
      wsRef.current.send("\r");
      e.preventDefault();
    } else if (e.key === "Backspace") {
      wsRef.current.send("\x7f");
      e.preventDefault();
    }
    // Clear the textarea so it doesn't accumulate
    if (mobileInputRef.current) mobileInputRef.current.value = "";
  }, []);

  const handleMobileInput = useCallback((e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    const text = target.value;
    if (text && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(text);
    }
    // Clear after sending
    target.value = "";
  }, []);

  return (
    <div
      ref={containerRef}
      onClick={() => {
        // On tap/click, focus the mobile input to bring up keyboard
        if (isWsMode) mobileInputRef.current?.focus();
      }}
      style={{
        maxHeight,
        overflow: "hidden",
        background: THEME.background,
        borderRadius: "0 0 0.5rem 0.5rem",
        position: "relative",
      }}
    >
      {isWsMode ? (
        <textarea
          ref={mobileInputRef}
          onPaste={handleMobilePaste}
          onKeyDown={handleMobileKeyDown}
          onInput={handleMobileInput}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="Terminal input"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            zIndex: 10,
            caretColor: "transparent",
            fontSize: "16px", // prevents iOS zoom on focus
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "transparent",
            pointerEvents: "auto",
          }}
        />
      ) : null}
    </div>
  );
});

export default XTermPane;
