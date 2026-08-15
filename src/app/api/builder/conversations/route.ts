import { and, desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { builderConversations } from "@/db/schema";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import {
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
} from "@/lib/http-status";

export const dynamic = "force-dynamic";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_TOTAL_LENGTH = 200_000;
const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
};

function response(body: unknown, status = STATUS_OK) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

function targetFromUrl(request: Request) {
  const url = new URL(request.url);
  return {
    workspaceId: url.searchParams.get("workspaceId")?.trim() ?? "",
    basePath: url.searchParams.get("basePath")?.trim() ?? "",
  };
}

function validateTarget(workspaceId: string, basePath: string): string | null {
  if (!workspaceId || workspaceId.length > 128) return "Invalid workspaceId";
  if (basePath.length > 512 || basePath.includes("\\") || basePath.split("/").includes("..")) {
    return "Invalid basePath";
  }
  return null;
}

function sanitizeMessages(value: unknown): StoredMessage[] | null {
  if (!Array.isArray(value)) return null;
  const sanitized: StoredMessage[] = [];
  let totalLength = 0;
  for (const entry of value.slice(-MAX_MESSAGES)) {
    if (!entry || typeof entry !== "object") return null;
    const message = entry as Record<string, unknown>;
    if (
      typeof message.id !== "string" ||
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string" ||
      typeof message.timestamp !== "string" ||
      message.content.length > MAX_MESSAGE_LENGTH ||
      Number.isNaN(Date.parse(message.timestamp))
    ) {
      return null;
    }
    totalLength += message.content.length;
    if (totalLength > MAX_TOTAL_LENGTH) return null;
    sanitized.push({
      id: message.id.slice(0, 160),
      role: message.role,
      content: message.content,
      timestamp: new Date(message.timestamp).toISOString(),
    });
  }
  return sanitized;
}

export async function GET(request: Request) {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;
  const { workspaceId, basePath } = targetFromUrl(request);

  // Without a target, return metadata only so a future profile history view
  // never has to fetch every conversation body.
  if (!workspaceId) {
    const rows = await db
      .select({
        workspaceId: builderConversations.workspaceId,
        basePath: builderConversations.basePath,
        updatedAt: builderConversations.updatedAt,
      })
      .from(builderConversations)
      .where(eq(builderConversations.agentId, owner.agentId))
      .orderBy(desc(builderConversations.updatedAt));
    return response({ success: true, conversations: rows });
  }

  const targetError = validateTarget(workspaceId, basePath);
  if (targetError) return response({ error: targetError }, STATUS_BAD_REQUEST);
  const row = await db.query.builderConversations.findFirst({
    where: and(
      eq(builderConversations.agentId, owner.agentId),
      eq(builderConversations.workspaceId, workspaceId),
      eq(builderConversations.basePath, basePath),
    ),
  });
  return response({ success: true, messages: row?.messages ?? [], updatedAt: row?.updatedAt ?? null });
}

export async function PUT(request: Request) {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;
  let body: { workspaceId?: unknown; basePath?: unknown; messages?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response({ error: "Invalid JSON body" }, STATUS_BAD_REQUEST);
  }
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const basePath = typeof body.basePath === "string" ? body.basePath.trim() : "";
  const targetError = validateTarget(workspaceId, basePath);
  if (targetError) return response({ error: targetError }, STATUS_BAD_REQUEST);
  const messages = sanitizeMessages(body.messages);
  if (!messages) return response({ error: "Invalid conversation messages" }, STATUS_BAD_REQUEST);

  try {
    await db
      .insert(builderConversations)
      .values({ agentId: owner.agentId, workspaceId, basePath, messages })
      .onConflictDoUpdate({
        target: [
          builderConversations.agentId,
          builderConversations.workspaceId,
          builderConversations.basePath,
        ],
        set: { messages, updatedAt: new Date() },
      });
    return response({ success: true, messageCount: messages.length });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "Failed to save conversation" },
      STATUS_INTERNAL_ERROR,
    );
  }
}
