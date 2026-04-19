import { NextRequest, NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  loadExecutiveSession,
  resumeOrCreateExecutive,
  updateExecutiveContextMounts,
  terminateExecutiveSession,
  saveExecutiveSession,
  appendExecutiveMessages,
  captureAgentPaneRaw,
  sendAgentInput,
  isExecutivePaneAlive,
  listAgentSessions,
  paneKeyForSession,
  registerChildSession,
} from "@/lib/agent-hq";
import type { ExecutiveContextMount, AgentLauncherProvider } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

function stripAnsi(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

function extractLatestClaudeReply(raw: string) {
  const text = stripAnsi(raw);
  if (!text.trim()) return null;
  const pattern = /(?:^|\n)●\s([\s\S]*?)(?=\n(?:\s*[❯>$]|\s*─{5,}|\s*⏵⏵|\s*$))/g;
  let match: RegExpExecArray | null = null;
  let latest: string | null = null;
  while ((match = pattern.exec(text)) !== null) {
    latest = match[1] ?? null;
  }
  return latest?.replace(/\n\s+/g, " ").replace(/\s+/g, " ").trim() || null;
}

function isToolProgressReply(reply: string | null) {
  if (!reply) return true;
  const normalized = reply.trim();
  if (!normalized) return true;
  return (
    /^Reading \d+ file/i.test(normalized) ||
    /^Read \d+ file/i.test(normalized) ||
    /^Searched for /i.test(normalized) ||
    /^Listed \d+/i.test(normalized) ||
    /^Using \d+ /i.test(normalized) ||
    /^Planning /i.test(normalized) ||
    /^Thinking /i.test(normalized) ||
    normalized.includes("(ctrl+o to expand)") ||
    normalized.includes("⎿ /")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GET /api/agent-hq/executive
 *
 * Returns the current executive session state, including liveness check
 * and optional terminal capture.
 *
 * Query params:
 *   capture=1  — include latest terminal output
 *   lines=N   — number of capture lines (default 90)
 */
export async function GET(request: NextRequest) {
  try {
    await assertAgentHqAccess();
    const session = await loadExecutiveSession();
    if (!session || session.state === "terminated") {
      return NextResponse.json({ session: null, alive: false });
    }

    const alive = await isExecutivePaneAlive(session.paneKey);
    if (!alive && session.state === "active") {
      session.state = "suspended";
    }

    const searchParams = request.nextUrl.searchParams;
    const wantCapture = searchParams.get("capture") === "1";
    const captureLines = Math.min(Number(searchParams.get("lines")) || 90, 500);

    let capture: string | null = null;
    if (wantCapture && alive) {
      try {
        capture = await captureAgentPaneRaw(session.paneKey, captureLines);
      } catch {
        capture = null;
      }
    }

    // Gather child session status
    const allSessions = await listAgentSessions();
    const children = allSessions
      .filter((s) => session.childPaneKeys.includes(paneKeyForSession(s)))
      .map((s) => ({
        paneKey: paneKeyForSession(s),
        label: s.metadata.label || s.title,
        role: s.metadata.role,
        dead: s.dead,
        objective: s.metadata.objective,
      }));

    return NextResponse.json({
      session,
      alive,
      capture,
      messages: session.messages ?? [],
      children,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load executive session";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ session: null, alive: false, error: message });
  }
}

/**
 * POST /api/agent-hq/executive
 *
 * Resume or create the executive session.
 *
 * Body (all optional):
 *   provider        — launcher provider (default "claude")
 *   cwd             — working directory
 *   personaId       — persona driving the executive
 *   personaName     — persona display name
 *   contextMounts   — initial context mounts
 *   voiceMode       — "browser" | "clone"
 */
export async function POST(request: NextRequest) {
  try {
    await assertAgentHqAccess();
    const body = await request.json().catch(() => ({}));
    const session = await resumeOrCreateExecutive({
      provider: (body.provider as AgentLauncherProvider) ?? undefined,
      cwd: typeof body.cwd === "string" ? body.cwd : undefined,
      personaId: body.personaId ?? null,
      personaName: typeof body.personaName === "string" ? body.personaName : undefined,
      contextMounts: Array.isArray(body.contextMounts) ? body.contextMounts : undefined,
      voiceMode: body.voiceMode === "clone" ? "clone" : body.voiceMode === "browser" ? "browser" : undefined,
    });
    if (!session.messages?.length) {
      const capture = await captureAgentPaneRaw(session.paneKey, 220).catch(() => "");
      const reply = extractLatestClaudeReply(capture);
      if (reply && !isToolProgressReply(reply)) {
        session.messages = [
          {
            id: `msg-${Date.now().toString(36)}-bootstrap`,
            role: "assistant",
            content: reply,
            createdAt: new Date().toISOString(),
          },
        ];
        await saveExecutiveSession(session);
      }
    }
    return NextResponse.json({ session, messages: session.messages ?? [], ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create executive session";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message, ok: false }, { status: 500 });
  }
}

/**
 * PATCH /api/agent-hq/executive
 *
 * Update the executive session.
 *
 * Body options:
 *   action: "updateMounts" — replace context mounts
 *     contextMounts: ExecutiveContextMount[]
 *   action: "send" — send input to the executive pane
 *     text: string, enter?: boolean
 *   action: "registerChild" — register a child pane
 *     childPaneKey: string
 *   action: "terminate" — end the executive session
 */
export async function PATCH(request: NextRequest) {
  try {
    await assertAgentHqAccess();
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      case "updateMounts": {
        const mounts = Array.isArray(body.contextMounts)
          ? (body.contextMounts as ExecutiveContextMount[])
          : [];
        const session = await updateExecutiveContextMounts(mounts);
        return NextResponse.json({ session, ok: true });
      }

      case "send": {
        const session = await loadExecutiveSession();
        if (!session || session.state !== "active") {
          return NextResponse.json({ error: "No active executive session", ok: false }, { status: 404 });
        }
        const text = typeof body.text === "string" ? body.text : "";
        const enter = body.enter !== false;
        const before = await captureAgentPaneRaw(session.paneKey, 220).catch(() => "");
        const previousReply = extractLatestClaudeReply(before);
        await appendExecutiveMessages({ role: "user", content: text });
        await sendAgentInput(session.paneKey, text, enter);
        let capture = before;
        let reply = previousReply;
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await sleep(attempt === 0 ? 400 : 800);
          capture = await captureAgentPaneRaw(session.paneKey, 220).catch(() => capture);
          const nextReply = extractLatestClaudeReply(capture);
          if (nextReply && nextReply !== previousReply && !isToolProgressReply(nextReply)) {
            reply = nextReply;
            break;
          }
        }
        let updatedSession = await loadExecutiveSession();
        if (reply && reply !== previousReply && !isToolProgressReply(reply)) {
          updatedSession = await appendExecutiveMessages({ role: "assistant", content: reply });
        }
        return NextResponse.json({
          ok: true,
          capture,
          reply,
          session: updatedSession,
          messages: updatedSession?.messages ?? [],
        });
      }

      case "registerChild": {
        const childPaneKey = typeof body.childPaneKey === "string" ? body.childPaneKey : "";
        if (!childPaneKey) {
          return NextResponse.json({ error: "childPaneKey required", ok: false }, { status: 400 });
        }
        const session = await registerChildSession(childPaneKey);
        return NextResponse.json({ session, messages: session?.messages ?? [], ok: true });
      }

      case "terminate": {
        const session = await terminateExecutiveSession();
        return NextResponse.json({ session, messages: session?.messages ?? [], ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}`, ok: false }, { status: 400 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update executive session";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    return NextResponse.json({ error: message, ok: false }, { status: 500 });
  }
}
