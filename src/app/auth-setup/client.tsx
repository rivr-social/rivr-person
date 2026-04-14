"use client";

import { useState, useRef } from "react";

export function AuthSetupClient() {
  const [status, setStatus] = useState<string>("Checking...");
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [paneKey, setPaneKey] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Check auth status on mount
  useState(() => {
    fetch("/api/agent-hq/claude-auth", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((d: { status?: { loggedIn?: boolean } }) => {
        if (d.status?.loggedIn) {
          setStatus("Claude Code is already logged in!");
        } else {
          setStatus("Not logged in. Click Start Login below.");
        }
      })
      .catch(() => setStatus("Could not check status."));
  });

  async function startLogin() {
    setStatus("Starting login...");
    setResult(null);
    try {
      const res = await fetch("/api/agent-hq/claude-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "login", mode: "claudeai" }),
      });
      const data = await res.json() as { ok?: boolean; error?: string; loginSession?: { paneKey: string } };
      if (!res.ok || !data.ok) {
        setStatus(`Login failed: ${data.error || res.statusText}`);
        return;
      }
      setPaneKey(data.loginSession?.paneKey ?? null);
      setStatus("Login session started. Waiting for URL...");

      // Poll for the auth URL
      const pk = data.loginSession?.paneKey;
      if (!pk) return;
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const capRes = await fetch(`/api/agent-hq/capture?target=${encodeURIComponent(pk)}&lines=40&raw=1`, {
          credentials: "same-origin",
        });
        const capData = await capRes.json() as { output?: string };
        const output = capData.output ?? "";
        const urlMatch = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").match(/https:\/\/claude\.com\/[^\s]+/);
        if (urlMatch) {
          setLoginUrl(urlMatch[0]);
          setStatus("Open the login link, authorize, then paste the code below.");
          return;
        }
      }
      setStatus("Could not find login URL. Try again.");
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }

  async function sendCode() {
    const code = inputRef.current?.value?.trim();
    if (!code || !paneKey) {
      setResult("Enter a code first.");
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const res = await fetch("/api/agent-hq/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ target: paneKey, text: code, enter: true }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setResult("Code sent! Checking login status...");
        if (inputRef.current) inputRef.current.value = "";
        // Wait and check
        await new Promise((r) => setTimeout(r, 5000));
        const statusRes = await fetch("/api/agent-hq/claude-auth", { credentials: "same-origin" });
        const statusData = await statusRes.json() as { status?: { loggedIn?: boolean } };
        if (statusData.status?.loggedIn) {
          setResult("Successfully logged in! You can close this page.");
          setStatus("Claude Code is logged in.");
        } else {
          setResult("Code sent but login not confirmed yet. It may take a moment, or the code may have expired.");
        }
      } else {
        setResult(`Send failed: ${data.error || res.statusText}`);
      }
    } catch (err) {
      setResult(`Error: ${err instanceof Error ? err.message : "Unknown"}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <div style={{ maxWidth: 500, margin: "80px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Claude Code Setup</h1>
      <p style={{ color: "#888", marginBottom: 24 }}>{status}</p>

      {!paneKey ? (
        <button
          onClick={startLogin}
          style={{
            padding: "12px 24px",
            fontSize: 16,
            background: "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          Start Login
        </button>
      ) : (
        <div>
          {loginUrl ? (
            <div style={{ marginBottom: 16 }}>
              <a
                href={loginUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-block",
                  padding: "12px 24px",
                  fontSize: 16,
                  background: "#3b82f6",
                  color: "white",
                  borderRadius: 8,
                  textDecoration: "none",
                }}
              >
                Open Claude Login →
              </a>
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <input
              ref={inputRef}
              type="text"
              placeholder="Paste auth code here"
              style={{
                flex: 1,
                padding: "12px 16px",
                fontSize: 16,
                border: "1px solid #444",
                borderRadius: 8,
                background: "#1a1a2e",
                color: "white",
                fontFamily: "monospace",
              }}
            />
            <button
              onClick={sendCode}
              disabled={sending}
              style={{
                padding: "12px 24px",
                fontSize: 16,
                background: sending ? "#666" : "#22c55e",
                color: "white",
                border: "none",
                borderRadius: 8,
                cursor: sending ? "default" : "pointer",
              }}
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </div>

          {result ? (
            <p style={{ marginTop: 16, padding: 12, background: "#1a1a2e", borderRadius: 8, color: result.includes("Success") ? "#22c55e" : "#f59e0b" }}>
              {result}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
