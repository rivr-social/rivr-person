/**
 * @fileoverview POST /api/builder/assistant — the agentic BUILDER ASSISTANT
 * (tool-loop sibling of the streaming generator chat at `/api/builder/chat`).
 *
 * Where the generator chat streams whole files for the client to parse, THIS
 * route runs a workspace-jailed tool loop (`makeBuilderToolset`:
 * list/read/write/delete + publish_site) over the CLIENT'S CURRENT workspace
 * (the builder page owns the files; it sends them and applies the returned
 * map). `publish_site` persists through the SAME owner-gated `publishSite`
 * service the Deploy button uses — never a parallel write path.
 *
 * Owner-only (this is a single-person instance): {@link resolveBuilderOwner}.
 * Model credential: the owner's Claude Code connector token when connected
 * (same resolution as the generator chat), else the instance env credential
 * inside native-chat.
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";
import { getSitePublication, publishSite } from "@/lib/builder/site-publications";
import { makeBuilderToolset } from "@/lib/builder/assistant-tools";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";
import { resolveClaudeCodeConnectorToken } from "@/lib/autobot-connector-secrets";
import {
  DEFAULT_MODEL,
  nativeCloudChat,
  type HistoryMessage,
} from "@/lib/ai/native-chat";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_HISTORY_LENGTH = 20;
const MAX_MESSAGE_LENGTH = 4000;

interface BuilderAssistantBody {
  message?: string;
  history?: Array<{ role?: string; content?: string }>;
  /** The builder page's CURRENT workspace — the map the assistant edits. */
  files?: SiteFiles;
}

function buildSystemPrompt(isPublished: boolean): string {
  return [
    "You are the site-builder assistant on this person's RIVR instance. You",
    "edit their static site workspace using the provided tools.",
    "",
    "Rules:",
    "- Start by calling list_files, and read_file before editing anything.",
    "- write_file replaces the ENTIRE file — always write complete contents.",
    "- Keep the site's existing structure and style unless asked to change it.",
    "- NEVER call publish_site unless the operator explicitly asked to publish",
    "  or deploy in this conversation turn. Edits are previewed first.",
    isPublished
      ? "- A published version is live; publishing replaces it."
      : "- Nothing is published yet; the first publish makes the site live.",
    "- After finishing, summarize what changed in one or two sentences.",
  ].join("\n");
}

function sanitizeHistory(history: BuilderAssistantBody["history"]): HistoryMessage[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (entry): entry is { role: string; content: string } =>
        !!entry &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string" &&
        entry.content.length > 0,
    )
    .slice(-MAX_HISTORY_LENGTH)
    .map((entry) => ({ role: entry.role as "user" | "assistant", content: entry.content }));
}

export async function POST(request: Request): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  let body: BuilderAssistantBody;
  try {
    body = (await request.json()) as BuilderAssistantBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: STATUS_BAD_REQUEST });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `A message of 1–${MAX_MESSAGE_LENGTH} characters is required.` },
      { status: STATUS_BAD_REQUEST },
    );
  }

  const baseFiles =
    body.files && typeof body.files === "object" && Object.keys(body.files).length > 0
      ? body.files
      : null;
  if (!baseFiles) {
    return NextResponse.json(
      { error: "The workspace is empty — generate or load site files first." },
      { status: STATUS_BAD_REQUEST },
    );
  }

  try {
    const publication = await getSitePublication(owner.agentId).catch(() => null);

    // Same credential resolution as the generator chat: the owner's Claude
    // Code connector token when connected; native-chat falls back to env.
    const { autobotSettings } = await resolveDirectAgent(owner.agentId);
    const claudeConnectorToken = resolveClaudeCodeConnectorToken(
      autobotSettings.connections,
    );

    const toolset = makeBuilderToolset(baseFiles, async (files) => {
      const result = await publishSite(owner.agentId, files, {
        commitMessage: "Published from the builder assistant",
      });
      return { versionNumber: result.versionNumber };
    });

    const chat = await nativeCloudChat({
      selectedModel: DEFAULT_MODEL,
      systemPrompt: buildSystemPrompt(publication?.publishedVersionNumber != null),
      history: sanitizeHistory(body.history),
      message,
      connectorToken: claudeConnectorToken ?? undefined,
      tools: toolset.tools,
      executeTool: toolset.executeTool,
    });

    const published = toolset.wasPublished();
    return NextResponse.json(
      {
        reply: chat.reply,
        files: toolset.getFiles(),
        changedPaths: toolset.getChangedPaths(),
        published,
        publication: published
          ? await getSitePublication(owner.agentId).catch(() => publication)
          : publication,
        toolCalls: chat.toolCalls ?? [],
      },
      { status: STATUS_OK, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "The builder assistant request failed.";
    console.error("[api/builder/assistant] failed:", error);
    return NextResponse.json({ error: messageText }, { status: STATUS_INTERNAL_ERROR });
  }
}
