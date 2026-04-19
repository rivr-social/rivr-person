import { NextResponse } from "next/server";
import { assertAgentHqAccess, captureAgentPaneRaw, sendAgentInput } from "@/lib/agent-hq";

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request) {
  let body: { target?: string; text?: string; enter?: boolean };
  try {
    body = (await request.json()) as { target?: string; text?: string; enter?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.target) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const before = await captureAgentPaneRaw(body.target, 220).catch(() => "");
    const previousReply = extractLatestClaudeReply(before);
    await sendAgentInput(body.target, body.text ?? "", body.enter !== false);
    let output = before;
    let reply = previousReply;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(attempt === 0 ? 400 : 800);
      output = await captureAgentPaneRaw(body.target, 220).catch(() => output);
      const nextReply = extractLatestClaudeReply(output);
      if (nextReply && nextReply !== previousReply) {
        reply = nextReply;
        break;
      }
    }
    return NextResponse.json({ ok: true, output, reply });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send input";
    if (message === "Authentication required") {
      return NextResponse.json({ error: message }, { status: 401 });
    }
    const normalized = message.toLowerCase();
    if (normalized.includes("can't find session") || normalized.includes("can't find pane")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    const status = 500;
    return NextResponse.json({ error: message }, { status });
  }
}
