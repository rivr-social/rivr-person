import { execFile } from "node:child_process";
import path from "node:path";
import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execClaude(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const runtimeHome = process.env.AGENT_HQ_CLAUDE_HOME
      ? path.resolve(process.env.AGENT_HQ_CLAUDE_HOME)
      : path.join(
          process.env.AGENT_HQ_DATA_DIR ? path.resolve(process.env.AGENT_HQ_DATA_DIR) : process.cwd(),
          "..",
          ".claude-runtime",
        );
    env.HOME = runtimeHome;
    env.XDG_CONFIG_HOME = path.join(runtimeHome, ".config");
    env.XDG_STATE_HOME = path.join(runtimeHome, ".local", "state");
    execFile("claude", args, { encoding: "utf8", maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function execTmux(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function sanitizeSessionName(value: string) {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "claude-auth";
}

async function readStatus(): Promise<ClaudeAuthStatus> {
  try {
    const raw = await execClaude(["auth", "status", "--json"]);
    const parsed = JSON.parse(raw) as ClaudeAuthStatus & { apiKeySource?: string };
    const isApiKeyAuth = parsed.authMethod === "api_key";
    const status: ClaudeAuthStatus = {
      loggedIn: isApiKeyAuth ? false : Boolean(parsed.loggedIn),
      authMethod: isApiKeyAuth ? undefined : parsed.authMethod,
      apiProvider: parsed.apiProvider,
      email: isApiKeyAuth ? undefined : parsed.email,
      orgId: isApiKeyAuth ? undefined : parsed.orgId,
      orgName: isApiKeyAuth ? undefined : parsed.orgName,
      subscriptionType: isApiKeyAuth ? undefined : parsed.subscriptionType,
    };

    return status;
  } catch {
    // claude auth status fails when no OAuth login exists and API key is stripped — that's expected
    return { loggedIn: false };
  }
}

async function capturePane(paneKey: string, lines = 80) {
  return execTmux(["capture-pane", "-p", "-e", "-t", paneKey, "-S", String(-Math.abs(lines))]);
}

async function submitCodeToPane(paneKey: string, code: string) {
  await execTmux(["send-keys", "-l", "-t", paneKey, code]);
  await execTmux(["send-keys", "-t", paneKey, "C-m"]);
  await delay(1500);
  const [status, output] = await Promise.all([
    readStatus().catch(() => ({ loggedIn: false } satisfies ClaudeAuthStatus)),
    capturePane(paneKey).catch(() => ""),
  ]);
  return { status, output };
}

export async function GET() {
  try {
    await assertAgentHqAccess();
    const status = await readStatus();
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read Claude auth status";
    const statusCode = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ ok: false, error: message }, { status: statusCode });
  }
}

export async function POST(request: Request) {
  try {
    await assertAgentHqAccess();
    const contentType = request.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      const form = await request.formData().catch(() => null);
      const action = String(form?.get("action") ?? "");
      if (action === "submitCode") {
        const paneKey = String(form?.get("paneKey") ?? "").trim();
        const code = String(form?.get("code") ?? "").trim();
        if (!paneKey || !code) {
          return new Response("<html><body>paneKey and code are required</body></html>", {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
        const { status, output } = await submitCodeToPane(paneKey, code);
        const html = `<!doctype html><html><body><script>
window.parent && window.parent.postMessage(${JSON.stringify({
  type: "claude-auth-submit",
  loggedIn: status.loggedIn,
  output,
})}, "*");
</script>submitted</body></html>`;
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("<html><body>Unsupported form submission</body></html>", {
        status: 400,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    const body = (await request.json().catch(() => ({}))) as {
      action?: "login" | "logout" | "submitCode";
      email?: string;
      mode?: "claudeai" | "console";
      sso?: boolean;
      paneKey?: string;
      code?: string;
    };

    if (body.action === "logout") {
      await execClaude(["auth", "logout"]);
      const status = await readStatus().catch(() => ({ loggedIn: false } satisfies ClaudeAuthStatus));
      return NextResponse.json({ ok: true, status });
    }

    if (body.action === "submitCode") {
      const paneKey = body.paneKey?.trim();
      const code = body.code?.trim();
      if (!paneKey || !code) {
        return NextResponse.json({ ok: false, error: "paneKey and code are required" }, { status: 400 });
      }
      const { status, output } = await submitCodeToPane(paneKey, code);
      return NextResponse.json({
        ok: true,
        status,
        output,
      });
    }

    const sessionName = `${sanitizeSessionName(`claude-auth-${Date.now().toString(36)}`)}`.slice(0, 32);

    const runtimeHome = process.env.AGENT_HQ_CLAUDE_HOME
      ? path.resolve(process.env.AGENT_HQ_CLAUDE_HOME)
      : path.join(
          process.env.AGENT_HQ_DATA_DIR ? path.resolve(process.env.AGENT_HQ_DATA_DIR) : process.cwd(),
          "..",
          ".claude-runtime",
        );
    const configHome = path.join(runtimeHome, ".config");
    const stateHome = path.join(runtimeHome, ".local", "state");
    const shellCommand =
      `env -u ANTHROPIC_API_KEY HOME=${JSON.stringify(runtimeHome)} ` +
      `XDG_CONFIG_HOME=${JSON.stringify(configHome)} XDG_STATE_HOME=${JSON.stringify(stateHome)} ` +
      "claude";
    await execTmux(["new-session", "-d", "-s", sessionName]);
    await execTmux(["send-keys", "-l", "-t", `${sessionName}:0.0`, shellCommand]);
    await execTmux(["send-keys", "-t", `${sessionName}:0.0`, "C-m"]);
    // Claude Code first-run setup prompts for theme and login method before it
    // reaches the actual OAuth/code prompt. Accept the default dark theme and
    // Claude subscription login method so the user lands on the real sign-in step.
    await delay(1400);
    await execTmux(["send-keys", "-l", "-t", `${sessionName}:0.0`, "1"]);
    await execTmux(["send-keys", "-t", `${sessionName}:0.0`, "C-m"]);
    await delay(1400);
    await execTmux(["send-keys", "-l", "-t", `${sessionName}:0.0`, "1"]);
    await execTmux(["send-keys", "-t", `${sessionName}:0.0`, "C-m"]);
    const paneKey = `${sessionName}:0.0`;

    return NextResponse.json({
      ok: true,
      loginSession: {
        sessionName,
        paneKey,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Claude auth";
    const statusCode = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ ok: false, error: message }, { status: statusCode });
  }
}
