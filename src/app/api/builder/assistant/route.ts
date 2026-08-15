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
import { deploySiteAsApp, SiteAppBridgeError } from "@/lib/builder/site-app-bridge";
import { AppLifecycleError, readAppStatus } from "@/lib/builder/app-lifecycle";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  queueWorkspaceDeployment,
  resolveBuilderWorkspace,
  waitForWorkspaceDeployment,
  writeWorkspaceSiteFiles,
} from "@/lib/builder/workspace-site";
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
const EDIT_INTENT_RE = /\b(add|adjust|change|create|delete|edit|fix|make|modify|remove|rename|replace|set|update)\b/i;

interface AssistantWorkspaceDeployment {
  request: { requestId: string };
  result: {
    status: string;
    url?: string;
    error?: string;
  } | null;
}

interface BuilderAssistantBody {
  message?: string;
  history?: Array<{ role?: string; content?: string }>;
  /** The builder page's CURRENT workspace — the map the assistant edits. */
  files?: SiteFiles;
  target?: {
    workspaceId?: string;
    basePath?: string;
  };
}

function buildSystemPrompt(
  isPublished: boolean,
  target?: { label: string; basePath: string; liveSubdomain?: string | null },
): string {
  return [
    "You are the builder assistant on this person's RIVR instance. You edit",
    "the selected site or app workspace using the provided tools.",
    target
      ? `- Your selected target is ${target.label}${target.basePath ? ` at ${target.basePath}` : ""}${target.liveSubdomain ? `, live at https://${target.liveSubdomain}/` : ""}.`
      : "- Your selected target is the person's default sovereign site.",
    "",
    "Rules:",
    "- Start by calling list_files, and read_file before editing anything.",
    "- Prefer replace_in_file for localized CSS, copy, and code changes.",
    "- write_file replaces the ENTIRE file; use it only when creating a file",
    "  or when a full rewrite is genuinely needed.",
    "- For visual CSS requests, inspect the cascade and variables, change the",
    "  declaration that actually controls the rendered element, then read the",
    "  changed area again to verify it.",
    "- Keep the site's existing structure and style unless asked to change it.",
    "- NEVER call publish_site or deploy_site_environment unless the operator",
    "  explicitly asked to publish or deploy in this conversation turn. Edits",
    "  are previewed first.",
    "- Never announce an edit and stop: if you say you are changing a file,",
    "  complete the write_file call in this SAME turn.",
    target
      ? "- publish_site saves the CURRENT files to the selected workspace and queues that exact app/site for deployment."
      : "- publish_site updates the person's default instance-served site.",
    "- deploy_site_environment",
    "  ships the workspace as its OWN static-app environment (own container +",
    "  hostname) via the app broker — use it when the operator asks to deploy",
    "  the site as its own app/environment.",
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

function requestsWorkspaceEdit(message: string): boolean {
  if (/^\s*(how|what|where|why)\b/i.test(message)) return false;
  return EDIT_INTENT_RE.test(message);
}

async function waitForAppDeployment(appId: string, requestId: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = await readAppStatus(appId);
    if (status?.requestId === requestId) {
      if (status.phase === "running") {
        return { status: "deployed", url: status.url };
      }
      if (status.phase === "failed") {
        return { status: "failed", error: status.error };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
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
    const targetWorkspaceId = body.target?.workspaceId?.trim() ?? "";
    const targetBasePath = body.target?.basePath?.trim() ?? "";
    let targetWorkspace: Awaited<ReturnType<typeof resolveBuilderWorkspace>> = null;
    if (targetWorkspaceId) {
      await assertAgentHqAccess();
      targetWorkspace = await resolveBuilderWorkspace(targetWorkspaceId);
      if (!targetWorkspace) {
        return NextResponse.json(
          { error: "The selected builder workspace is unavailable." },
          { status: STATUS_BAD_REQUEST },
        );
      }
    }

    const publication = targetWorkspace
      ? null
      : await getSitePublication(owner.agentId).catch(() => null);

    // Same credential resolution as the generator chat: the owner's Claude
    // Code connector token when connected; native-chat falls back to env.
    const { autobotSettings } = await resolveDirectAgent(owner.agentId);
    const claudeConnectorToken = resolveClaudeCodeConnectorToken(
      autobotSettings.connections,
    );

    let workspaceDeployment: AssistantWorkspaceDeployment | null = null;
    let workspaceDeploymentWaiter: (() => Promise<AssistantWorkspaceDeployment["result"]>) | null = null;
    const toolset = makeBuilderToolset(baseFiles, async (files) => {
      if (targetWorkspace) {
        await writeWorkspaceSiteFiles(targetWorkspace, files, targetBasePath);
        if (!targetWorkspace.deployRoot) {
          const brokerRequest = await deploySiteAsApp(
            targetWorkspace.name,
            targetWorkspace.label,
            files,
          );
          workspaceDeployment = {
            request: { requestId: brokerRequest.requestId },
            result: null,
          };
          workspaceDeploymentWaiter = () =>
            waitForAppDeployment(brokerRequest.appId, brokerRequest.requestId);
          return {
            requestId: brokerRequest.requestId,
            status: "queued",
            target: targetWorkspace.label,
            lane: "app-broker",
          };
        }
        const deployRequest = await queueWorkspaceDeployment(targetWorkspace);
        workspaceDeployment = {
          request: { requestId: deployRequest.requestId },
          result: null,
        };
        workspaceDeploymentWaiter = async () => {
          const result = await waitForWorkspaceDeployment(
            targetWorkspace!,
            deployRequest.requestId,
          );
          return result
            ? { status: result.status ?? "unknown", url: result.url, error: result.error }
            : null;
        };
        return {
          requestId: deployRequest.requestId,
          status: "queued",
          target: targetWorkspace.label,
          url: targetWorkspace.liveSubdomain
            ? `https://${targetWorkspace.liveSubdomain}/`
            : undefined,
        };
      }
      const result = await publishSite(owner.agentId, files, {
        commitMessage: "Published from the builder assistant",
      });
      return { versionNumber: result.versionNumber };
    });

    // Own-environment deploy tool (broker lane). Offered only when the caller
    // holds agent-hq access — the same gate as /api/builder/apps.
    let environmentDeployed: { appId: string; requestId: string } | null = null;
    const canUseAppLane = !targetWorkspace && await assertAgentHqAccess()
      .then(() => true)
      .catch(() => false);
    const deployTool = {
      name: "deploy_site_environment",
      description:
        "Deploy the CURRENT workspace as its OWN static-app environment (own container + hostname) via the app broker. Only when the operator explicitly asked to deploy the site as its own app/environment.",
      input_schema: {
        type: "object",
        properties: {
          app_id: {
            type: "string",
            description:
              "Lowercase app id (2-32 chars: letters, digits, dashes) — becomes the subdomain.",
          },
        },
        required: ["app_id"],
        additionalProperties: false,
      },
    };
    const tools = canUseAppLane ? [...toolset.tools, deployTool] : toolset.tools;
    const executeTool = async (
      name: string,
      input: Record<string, unknown>,
    ): Promise<unknown> => {
      if (name === "deploy_site_environment") {
        if (!canUseAppLane) return { error: "The app lane is not available here." };
        const appId = typeof input.app_id === "string" ? input.app_id.trim().toLowerCase() : "";
        try {
          const result = await deploySiteAsApp(appId, appId, toolset.getFiles());
          environmentDeployed = { appId: result.appId, requestId: result.requestId };
          return {
            ok: true,
            ...result,
            note: "Deploy queued — the broker builds and routes it; check the Apps tab for the live URL.",
          };
        } catch (error) {
          if (error instanceof SiteAppBridgeError || error instanceof AppLifecycleError) {
            return { error: error.message };
          }
          throw error;
        }
      }
      return toolset.executeTool(name, input);
    };

    const cleanHistory = sanitizeHistory(body.history);
    let chat = await nativeCloudChat({
      selectedModel: DEFAULT_MODEL,
      systemPrompt: buildSystemPrompt(
        publication?.publishedVersionNumber != null,
        targetWorkspace
          ? {
              label: targetWorkspace.label,
              basePath: targetBasePath,
              liveSubdomain: targetWorkspace.liveSubdomain,
            }
          : undefined,
      ),
      history: cleanHistory,
      message,
      connectorToken: claudeConnectorToken ?? undefined,
      tools,
      executeTool,
    });

    // A builder assistant that merely narrates an explicitly requested edit is
    // not a successful turn. Give the model one bounded corrective pass over
    // the same working copy; the path jail and publish gate remain unchanged.
    if (
      requestsWorkspaceEdit(message) &&
      toolset.getChangedPaths().length === 0 &&
      !toolset.wasPublished() &&
      !environmentDeployed
    ) {
      const firstReply = chat.reply;
      const firstToolCalls = chat.toolCalls ?? [];
      const retry = await nativeCloudChat({
        selectedModel: DEFAULT_MODEL,
        systemPrompt: buildSystemPrompt(
          publication?.publishedVersionNumber != null,
          targetWorkspace
            ? {
                label: targetWorkspace.label,
                basePath: targetBasePath,
                liveSubdomain: targetWorkspace.liveSubdomain,
              }
            : undefined,
        ),
        history: [
          ...cleanHistory,
          { role: "user", content: message },
          { role: "assistant", content: firstReply },
        ],
        message:
          "You described the requested change but did not modify a file. Use the workspace tools now, verify the edit, and then summarize the completed change.",
        connectorToken: claudeConnectorToken ?? undefined,
        tools,
        executeTool,
      });
      chat = {
        ...retry,
        toolCalls: [...firstToolCalls, ...(retry.toolCalls ?? [])],
      };
    }

    const published = toolset.wasPublished();
    const completedWorkspaceDeployment = workspaceDeployment as AssistantWorkspaceDeployment | null;
    const completedWorkspaceDeploymentWaiter = workspaceDeploymentWaiter as
      | (() => Promise<AssistantWorkspaceDeployment["result"]>)
      | null;
    if (completedWorkspaceDeployment && completedWorkspaceDeploymentWaiter) {
      completedWorkspaceDeployment.result = await completedWorkspaceDeploymentWaiter();
    }
    return NextResponse.json(
      {
        reply: chat.reply,
        files: toolset.getFiles(),
        changedPaths: toolset.getChangedPaths(),
        published,
        publication: published && !targetWorkspace
          ? await getSitePublication(owner.agentId).catch(() => publication)
          : publication,
        workspaceDeployment: completedWorkspaceDeployment,
        environmentDeployed,
        toolCalls: chat.toolCalls ?? [],
      },
      { status: STATUS_OK, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : "The builder assistant request failed.";
    // A missing model credential is a CONFIG state, not a server fault — 400
    // keeps error logs honest and tells the client it is actionable.
    const isCredentialGap = /credential|api key|oauth|anthropic_api_key/i.test(messageText);
    console.error("[api/builder/assistant] failed:", error);
    return NextResponse.json(
      { error: messageText },
      { status: isCredentialGap ? STATUS_BAD_REQUEST : STATUS_INTERNAL_ERROR },
    );
  }
}
