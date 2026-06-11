/**
 * Outbound Dispatch — send messages and content through connected services.
 *
 * Connectors declare outbound capabilities (write_messages, write_posts, etc.)
 * but previously had no dispatch implementation. This module provides the
 * actual send/post functions for each supported provider.
 *
 * Flow: MCP tool call → outbound-dispatch → provider API → response
 */

import { db } from "@/db";
import { accounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchResult {
  success: boolean;
  provider: string;
  messageId?: string;
  permalink?: string;
  error?: string;
}

export type DispatchTarget =
  | { provider: "slack"; channel: string; text: string; threadTs?: string }
  | { provider: "discord"; channelId: string; content: string }
  | { provider: "email"; to: string; subject: string; body: string };

// ---------------------------------------------------------------------------
// Token Resolution
// ---------------------------------------------------------------------------

async function getProviderAccessToken(
  userId: string,
  provider: string,
): Promise<string | null> {
  const [account] = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
    .limit(1);

  return account?.accessToken ?? null;
}

// ---------------------------------------------------------------------------
// Slack Dispatch
// ---------------------------------------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";

async function dispatchSlack(
  userId: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<DispatchResult> {
  const token = await getProviderAccessToken(userId, "slack");
  if (!token) {
    return { success: false, provider: "slack", error: "No Slack OAuth token — connect Slack first." };
  }

  const body: Record<string, string> = { channel, text };
  if (threadTs) body.thread_ts = threadTs;

  const res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as { ok: boolean; ts?: string; error?: string; channel?: string };

  if (!data.ok) {
    return { success: false, provider: "slack", error: data.error ?? "Slack API error" };
  }

  const permalink = data.channel && data.ts
    ? `https://slack.com/archives/${data.channel}/p${data.ts.replace(".", "")}`
    : undefined;

  return {
    success: true,
    provider: "slack",
    messageId: data.ts,
    permalink,
  };
}

// ---------------------------------------------------------------------------
// Discord Dispatch
// ---------------------------------------------------------------------------

const DISCORD_API_BASE = "https://discord.com/api/v10";

async function dispatchDiscord(
  userId: string,
  channelId: string,
  content: string,
): Promise<DispatchResult> {
  const token = await getProviderAccessToken(userId, "discord");
  if (!token) {
    return { success: false, provider: "discord", error: "No Discord OAuth token — connect Discord first." };
  }

  const res = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    return { success: false, provider: "discord", error: `Discord API error (${res.status}): ${errorText.slice(0, 200)}` };
  }

  const data = (await res.json()) as { id?: string };
  return {
    success: true,
    provider: "discord",
    messageId: data.id,
  };
}

// ---------------------------------------------------------------------------
// Email Dispatch (delegates to existing mailer)
// ---------------------------------------------------------------------------

async function dispatchEmail(
  to: string,
  subject: string,
  body: string,
): Promise<DispatchResult> {
  try {
    const { sendEmail } = await import("@/lib/email");
    const result = await sendEmail({ to, subject, text: body, html: body });
    if (!result.success) {
      return { success: false, provider: "email", error: result.error ?? "Email send failed" };
    }
    return { success: true, provider: "email", messageId: result.messageId };
  } catch (err) {
    return {
      success: false,
      provider: "email",
      error: err instanceof Error ? err.message : "Email dispatch failed",
    };
  }
}

// ---------------------------------------------------------------------------
// Unified Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a message through a connected external service.
 *
 * @param userId The agent ID whose OAuth credentials to use.
 * @param target The dispatch target (provider + params).
 * @returns Result with success flag and optional message ID / permalink.
 */
export async function dispatch(
  userId: string,
  target: DispatchTarget,
): Promise<DispatchResult> {
  switch (target.provider) {
    case "slack":
      return dispatchSlack(userId, target.channel, target.text, target.threadTs);
    case "discord":
      return dispatchDiscord(userId, target.channelId, target.content);
    case "email":
      return dispatchEmail(target.to, target.subject, target.body);
    default:
      return {
        success: false,
        provider: (target as { provider: string }).provider,
        error: `Outbound dispatch not yet supported for this provider.`,
      };
  }
}
