import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { auth } from "@/auth";
import { getDeployCapability } from "@/lib/deploy/capability";
import { ensureSessionContextFolder } from "@/lib/agent-docs";

export type AgentRole = "executive" | "architect" | "orchestrator" | "worker" | "observer";
export type AgentLauncherProvider = "claude" | "codex" | "opencode" | "custom";
export type AgentWorkspaceScope = "foundation" | "app" | "shared";
export type AgentCapability =
  | "edit"
  | "git"
  | "deploy"
  | "dns"
  | "kg_read"
  | "kg_write"
  | "foundation_read"
  | "foundation_deploy";

export interface AgentSessionMetadata {
  role: AgentRole;
  parent: string | null;
  label: string;
  notes: string;
  objective: string;
  provider?: AgentLauncherProvider;
  cwd?: string;
  displayLabel?: string;
  commandTemplate?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceScope?: AgentWorkspaceScope;
  capabilityIds?: AgentCapability[];
  contextFile?: string;
  liveSubdomain?: string;
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
  mountedPaths?: string[];
}

export interface AgentSession {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  command: string;
  pid: number;
  title: string;
  active: boolean;
  dead: boolean;
  metadata: AgentSessionMetadata;
}

export interface AgentWorkspace {
  id: string;
  name: string;
  label: string;
  cwd: string;
  packageName?: string | null;
  scope: AgentWorkspaceScope;
  description: string;
  deployRoot?: string | null;
  liveSubdomain?: string | null;
  foundationId?: string | null;
}

export interface AgentWorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface AgentWorkspaceRegistry {
  version: number;
  workspaceRoot: string;
  appWorkspaceRoot: string;
  workspaces: AgentWorkspace[];
  updatedAt: string;
}

export interface AgentSessionRegistry {
  version: number;
  sessions: AgentSession[];
  templates: AgentSessionTemplate[];
  updatedAt: string;
}

export interface AgentSessionTemplate {
  id: string;
  name: string;
  mode: "architect" | "team";
  preset: "default" | "guide_builder";
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentTeamNode {
  id: string;
  label: string;
  role: AgentRole;
  parentId: string | null;
  workspaceId: string | null;
  notes: string;
  objective: string;
  capabilityIds: AgentCapability[];
}

export interface AgentTeamGraph {
  version: number;
  roots: string[];
  nodes: Record<string, AgentTeamNode>;
  updatedAt: string;
}

export interface AgentLauncher {
  provider: AgentLauncherProvider;
  label: string;
  description: string;
  installed: boolean;
  defaultCommandTemplate?: string;
}

/* ------------------------------------------------------------------ */
/*  Executive Session Model                                           */
/* ------------------------------------------------------------------ */

export type ExecutiveSessionState = "active" | "suspended" | "terminated";

/** A context mount attached to the executive session. */
export interface ExecutiveContextMount {
  kind: "person" | "persona" | "group" | "kg-scope" | "workspace";
  id: string;
  label: string;
  /** Provider-specific reference (e.g. workspace cwd, KG scope id). */
  ref?: string;
}

/** Persistent executive session descriptor stored on disk. */
export interface ExecutiveSession {
  /** Stable session identifier (survives page reloads). */
  id: string;
  /** tmux session name backing this executive. */
  tmuxSession: string;
  /** tmux pane key (%<id> or session:window.pane). */
  paneKey: string;
  /** Agent launcher provider running inside the pane. */
  provider: AgentLauncherProvider;
  /** Working directory the executive was launched in. */
  cwd: string;
  /** Human label. */
  label: string;
  /** Current lifecycle state. */
  state: ExecutiveSessionState;
  /** Attached context mounts. */
  contextMounts: ExecutiveContextMount[];
  /** Persona driving this executive (optional). */
  personaId: string | null;
  personaName?: string;
  /** Voice mode preference forwarded from autobot settings. */
  voiceMode?: "browser" | "clone";
  /** Child session pane keys owned by this executive. */
  childPaneKeys: string[];
  /** Server-owned chat transcript for the executive bubble. */
  messages: ExecutiveChatMessage[];
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last activity / resume. */
  updatedAt: string;
}

export interface ExecutiveChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

/**
 * In Docker the WORKDIR `/app` is read-only for the nextjs user, so
 * `process.cwd()/.agent-hq` fails with EACCES. Use the cwd path only when
 * it is actually writable; otherwise fall back to `$HOME/.agent-hq` (which
 * maps to `/tmp/.agent-hq` in the container — always writable).
 */
function resolveWritableDataDir(): string {
  const cwdCandidate = path.join(process.cwd(), ".agent-hq");
  try {
    // If the directory already exists locally (dev), keep using it.
    if (existsSync(cwdCandidate)) return cwdCandidate;
    // Probe whether we can create it — check parent for write access.
    accessSync(process.cwd(), fsConstants.W_OK);
    return cwdCandidate;
  } catch {
    // cwd not writable (Docker / read-only deploy) — use HOME.
    const home = process.env.HOME || "/tmp";
    return path.join(home, ".agent-hq");
  }
}

const DATA_DIR = process.env.AGENT_HQ_DATA_DIR
  ? path.resolve(process.env.AGENT_HQ_DATA_DIR)
  : resolveWritableDataDir();
const METADATA_PATH = path.join(DATA_DIR, "agent-metadata.json");
const SESSION_REGISTRY_PATH = path.join(DATA_DIR, "session-registry.json");
const WORKSPACE_REGISTRY_PATH = path.join(DATA_DIR, "workspace-registry.json");
const TEAM_GRAPH_PATH = path.join(DATA_DIR, "team-graph.json");
const CONTEXT_DIR = path.join(DATA_DIR, "contexts");
const OPS_ROOT = process.env.AGENT_HQ_WORKSPACE_ROOT
  ? path.resolve(process.env.AGENT_HQ_WORKSPACE_ROOT)
  : path.resolve(process.cwd(), "..");
const USER_DOCUMENTS_ROOT = process.env.HOME ? path.join(process.env.HOME, "Documents") : OPS_ROOT;
const APP_WORKSPACE_ROOT = process.env.AGENT_HQ_APP_WORKSPACE_ROOT
  ? path.resolve(process.env.AGENT_HQ_APP_WORKSPACE_ROOT)
  : path.join(USER_DOCUMENTS_ROOT, "Playground");
const SWARM_STATE_DIR = path.join(OPS_ROOT, ".agent-hq", "swarm-state");
const SWARM_STATE_LEDGER_PATH = path.join(SWARM_STATE_DIR, "current-state.json");
const CLAUDE_RUNTIME_HOME = process.env.AGENT_HQ_CLAUDE_HOME
  ? path.resolve(process.env.AGENT_HQ_CLAUDE_HOME)
  : path.join(process.env.AGENT_HQ_DATA_DIR ? path.resolve(process.env.AGENT_HQ_DATA_DIR) : DATA_DIR, "..", ".claude-runtime");

function buildClaudeRuntimePrefix() {
  const runtimeHome = shellQuote(CLAUDE_RUNTIME_HOME);
  const xdgConfigHome = shellQuote(path.join(CLAUDE_RUNTIME_HOME, ".config"));
  const xdgStateHome = shellQuote(path.join(CLAUDE_RUNTIME_HOME, ".local", "state"));
  return `env -u ANTHROPIC_API_KEY HOME=${runtimeHome} XDG_CONFIG_HOME=${xdgConfigHome} XDG_STATE_HOME=${xdgStateHome}`;
}

export function getAgentAppWorkspaceRoot() {
  return APP_WORKSPACE_ROOT;
}
const DEFAULT_METADATA: AgentSessionMetadata = {
  role: "worker",
  parent: null,
  label: "",
  notes: "",
  objective: "",
};

function execTmux(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("tmux", args, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function isTmuxServerMissing(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no server running on") ||
    normalized.includes("failed to connect to server") ||
    normalized.includes("error connecting to") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("can't find socket")
  );
}

function isTmuxUnavailable(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("spawn tmux enoent") || normalized.includes("tmux: not found");
}

async function ensureMetadataStore() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
  if (!existsSync(CONTEXT_DIR)) {
    await mkdir(CONTEXT_DIR, { recursive: true });
  }
  if (!existsSync(METADATA_PATH)) {
    await writeFile(METADATA_PATH, "{}\n", "utf8");
  }
  if (!existsSync(SESSION_REGISTRY_PATH)) {
    await writeFile(
      SESSION_REGISTRY_PATH,
      JSON.stringify(
        {
          version: 1,
          sessions: [],
          templates: [],
          updatedAt: new Date().toISOString(),
        } satisfies AgentSessionRegistry,
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  if (!existsSync(WORKSPACE_REGISTRY_PATH)) {
    await writeFile(
      WORKSPACE_REGISTRY_PATH,
      JSON.stringify(
        {
          version: 1,
          workspaceRoot: OPS_ROOT,
          appWorkspaceRoot: APP_WORKSPACE_ROOT,
          workspaces: [],
          updatedAt: new Date().toISOString(),
        } satisfies AgentWorkspaceRegistry,
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
  if (!existsSync(TEAM_GRAPH_PATH)) {
    await writeFile(
      TEAM_GRAPH_PATH,
      JSON.stringify(
        {
          version: 1,
          roots: [],
          nodes: {},
          updatedAt: new Date().toISOString(),
        } satisfies AgentTeamGraph,
        null,
        2,
      ) + "\n",
      "utf8",
    );
  }
}

async function loadMetadataStore(): Promise<Record<string, AgentSessionMetadata>> {
  await ensureMetadataStore();
  const raw = await readFile(METADATA_PATH, "utf8");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveMetadataStore(metadata: Record<string, AgentSessionMetadata>) {
  await ensureMetadataStore();
  await writeFile(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function loadSessionRegistry(): Promise<AgentSessionRegistry> {
  await ensureMetadataStore();
  const registry = await loadJsonFile<AgentSessionRegistry>(SESSION_REGISTRY_PATH, {
    version: 1,
    sessions: [],
    templates: [],
    updatedAt: new Date().toISOString(),
  });
  return {
    version: 1,
    sessions: Array.isArray(registry.sessions) ? registry.sessions : [],
    templates: Array.isArray(registry.templates) ? registry.templates : [],
    updatedAt: registry.updatedAt ?? new Date().toISOString(),
  };
}

export async function saveSessionRegistry(sessions: AgentSession[]): Promise<AgentSessionRegistry> {
  const current = await loadSessionRegistry();
  const registry: AgentSessionRegistry = {
    version: 1,
    sessions,
    templates: current.templates ?? [],
    updatedAt: new Date().toISOString(),
  };
  await saveJsonFile(SESSION_REGISTRY_PATH, registry);
  return registry;
}

export async function loadSessionTemplates(): Promise<AgentSessionTemplate[]> {
  const registry = await loadSessionRegistry();
  return registry.templates ?? [];
}

export async function saveSessionTemplates(templates: AgentSessionTemplate[]): Promise<AgentSessionTemplate[]> {
  const registry = await loadSessionRegistry();
  const next = {
    ...registry,
    templates,
    updatedAt: new Date().toISOString(),
  } satisfies AgentSessionRegistry;
  await saveJsonFile(SESSION_REGISTRY_PATH, next);
  return next.templates;
}

export async function upsertSessionTemplate(
  template: Omit<AgentSessionTemplate, "createdAt" | "updatedAt">,
): Promise<AgentSessionTemplate[]> {
  const current = await loadSessionTemplates();
  const now = new Date().toISOString();
  const next = [...current];
  const index = next.findIndex((entry) => entry.id === template.id);
  const merged: AgentSessionTemplate = {
    ...template,
    createdAt: index >= 0 ? next[index].createdAt : now,
    updatedAt: now,
  };
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return saveSessionTemplates(next);
}

async function loadJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  if (!existsSync(filePath)) {
    return fallback;
  }
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

async function saveJsonFile(filePath: string, value: unknown) {
  await ensureMetadataStore();
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sortWorkspaces(workspaces: AgentWorkspace[]) {
  return [...workspaces].sort((a, b) => {
    const scopeRank = (scope: AgentWorkspaceScope) =>
      scope === "foundation" ? 0 : scope === "app" ? 1 : 2;
    return scopeRank(a.scope) - scopeRank(b.scope) || a.label.localeCompare(b.label);
  });
}

function mergeWorkspaces(base: AgentWorkspace[], overlay: AgentWorkspace[]) {
  const byId = new Map<string, AgentWorkspace>();
  for (const workspace of [...base, ...overlay]) {
    byId.set(workspace.id, workspace);
  }
  return sortWorkspaces(Array.from(byId.values()));
}

function normalizeMetadata(input?: Partial<AgentSessionMetadata>): AgentSessionMetadata {
  const kgScopeSet = Array.isArray(input?.kgScopeSet)
    ? Array.from(
        new Set(
          input.kgScopeSet.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      )
    : undefined;
  const mountedPaths = Array.isArray(input?.mountedPaths)
    ? Array.from(
        new Set(
          input.mountedPaths.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      )
    : undefined;
  return {
    ...DEFAULT_METADATA,
    ...input,
    label: input?.label ?? input?.displayLabel ?? DEFAULT_METADATA.label,
    displayLabel: input?.displayLabel ?? input?.label ?? undefined,
    parent: input?.parent ?? null,
    personaId: input?.personaId ?? null,
    personaName: input?.personaName?.trim() || undefined,
    kgScopeSet,
    mountedPaths,
  };
}

export function paneKeyForSession(
  session: Pick<AgentSession, "sessionName" | "windowIndex" | "paneIndex" | "paneId">,
) {
  if (typeof session.paneId === "string" && session.paneId.startsWith("%")) {
    return session.paneId;
  }
  return `${session.sessionName}:${session.windowIndex}.${session.paneIndex}`;
}

export async function assertAgentHqAccess() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error("Authentication required");
  }
  const capability = getDeployCapability();
  if (!capability.canAccessHost) {
    throw new Error("Agent terminal control is only available on sovereign instances.");
  }
}

export async function listAgentSessions(): Promise<AgentSession[]> {
  const format = [
    "#{session_name}",
    "#{window_index}",
    "#{pane_index}",
    "#{pane_id}",
    "#{pane_current_command}",
    "#{pane_pid}",
    "#{pane_active}",
    "#{pane_dead}",
  ].join("\t");
  let stdout = "";
  try {
    stdout = await execTmux(["list-panes", "-a", "-F", format]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isTmuxServerMissing(message) || isTmuxUnavailable(message)) {
      return [];
    }
    throw error;
  }
  const metadataStore = await loadMetadataStore();

  const lines = stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line) => {
      const splitOnTab = line.split("\t");
      const splitOnEscapedTab = line.split("\\t");
      let parts = splitOnTab.length >= 8 ? splitOnTab : splitOnEscapedTab;
      if (parts.length < 8) {
        const underscoreMatch = line.match(/^(.*)_(\d+)_(\d+)_(%[0-9]+)_([^_]+)_(\d+)_([01])_([01])$/);
        if (underscoreMatch) {
          parts = underscoreMatch.slice(1);
        }
      }
      if (parts.length < 8) {
        console.warn("[agent-hq] unable to parse tmux list-panes line", { line });
        return null;
      }

      const [sessionName, windowIndexRaw, paneIndexRaw, paneIdRaw, command, pidRaw, activeRaw, deadRaw] = parts;
      const windowIndex = Number(windowIndexRaw);
      const paneIndex = Number(paneIndexRaw);
      const pid = Number(pidRaw);
      const paneId = paneIdRaw?.trim() || "";

      const legacyPaneKey = `${sessionName}:${windowIndexRaw}.${paneIndexRaw}`;
      const metadataKey = paneId.startsWith("%") ? paneId : legacyPaneKey;
      const savedMetadata = metadataStore[metadataKey] ?? metadataStore[legacyPaneKey];
      const savedLabel =
        typeof savedMetadata?.label === "string" && !savedMetadata.label.endsWith(":null.null")
          ? savedMetadata.label
          : undefined;
      const fallbackKey = paneId.startsWith("%")
        ? paneId
        : `${sessionName}:${Number.isFinite(windowIndex) ? windowIndex : 0}.${Number.isFinite(paneIndex) ? paneIndex : 0}`;

      return {
        sessionName,
        windowIndex: Number.isFinite(windowIndex) ? windowIndex : 0,
        paneIndex: Number.isFinite(paneIndex) ? paneIndex : 0,
        paneId,
        command,
        pid: Number.isFinite(pid) ? pid : 0,
        title: savedLabel ?? fallbackKey,
        active: activeRaw === "1",
        dead: deadRaw === "1",
        metadata: normalizeMetadata({
          ...savedMetadata,
          label: savedLabel || fallbackKey,
        }),
      } satisfies AgentSession;
    })
    .filter((session): session is AgentSession => session !== null);
}

export async function captureAgentPane(target: string, lines = 120) {
  return execTmux(["capture-pane", "-p", "-t", target, "-S", String(-Math.abs(lines))]);
}

export async function captureAgentPaneRaw(target: string, lines = 120) {
  return execTmux(["capture-pane", "-p", "-e", "-t", target, "-S", String(-Math.abs(lines))]);
}

export async function sendAgentInput(target: string, text: string, enter = true) {
  if (text) {
    await execTmux(["send-keys", "-l", "-t", target, text]);
  }
  if (enter) {
    await execTmux(["send-keys", "-t", target, "C-m"]);
  }
}

export async function reloadAgentContext(paneKey: string) {
  const metadataStore = await loadMetadataStore();
  const metadata = metadataStore[paneKey];
  if (!metadata) {
    throw new Error("Session metadata not found.");
  }
  if (!metadata.contextFile) {
    throw new Error("No context file configured for this pane.");
  }
  await syncContextFileFromMetadata(paneKey, metadata);

  const prompt = [
    `Re-read the session context file at ${metadata.contextFile}.`,
    "Apply it as the active operating context before continuing.",
    metadata.personaId
      ? `Remain in persona context ${metadata.personaName ?? metadata.personaId}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  await sendAgentInput(paneKey, prompt, true);
}

export async function updateAgentMetadata(
  paneKey: string,
  metadata: Partial<AgentSessionMetadata>,
): Promise<AgentSessionMetadata> {
  const current = await loadMetadataStore();
  const next = normalizeMetadata({
    ...(current[paneKey] ?? {}),
    ...metadata,
  });
  current[paneKey] = next;
  await saveMetadataStore(current);
  await syncContextFileFromMetadata(paneKey, next);
  await upsertTeamNodeFromMetadata(paneKey, next);
  return next;
}

function isInsideAnyWorkspace(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  const allowedRoots = [OPS_ROOT, APP_WORKSPACE_ROOT];
  return allowedRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function replaceTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => values[key] ?? "");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsiForAgentOutput(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

async function settleClaudeStartup(target: string) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(700);
    const raw = await captureAgentPaneRaw(target, 120).catch(() => "");
    const text = stripAnsiForAgentOutput(raw);

    if (text.includes("Bypass Permissions mode") && text.includes("Yes, I accept")) {
      await sendAgentInput(target, "2", true);
      continue;
    }

    if (
      text.includes("? for shortcuts") ||
      text.includes("Paste code here if prompted") ||
      text.includes("cwd:") ||
      text.includes("> ")
    ) {
      return;
    }
  }
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function resolveWorkspaceForMetadata(metadata: AgentSessionMetadata) {
  const workspaces = await discoverAgentProjects();
  const metadataCwd = metadata.cwd ? path.resolve(metadata.cwd) : null;
  return (
    (metadata.workspaceId ? workspaces.find((candidate) => candidate.id === metadata.workspaceId) : null) ??
    (metadataCwd ? workspaces.find((candidate) => path.resolve(candidate.cwd) === metadataCwd) : null) ??
    null
  );
}

async function syncContextFileFromMetadata(sessionName: string, metadata: AgentSessionMetadata) {
  if (!metadata.contextFile || !metadata.cwd || !metadata.provider) return;
  const workspace = await resolveWorkspaceForMetadata(metadata);
  await writeFile(
    metadata.contextFile,
    renderAgentContext({
      sessionName,
      workspace,
      cwd: metadata.cwd,
      provider: metadata.provider,
      role: metadata.role,
      objective: metadata.objective,
      notes: metadata.notes,
      capabilities: metadata.capabilityIds ?? [],
      personaId: metadata.personaId ?? null,
      personaName: metadata.personaName,
      kgScopeSet: metadata.kgScopeSet,
      mountedPaths: metadata.mountedPaths,
    }),
    "utf8",
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "agent";
}

function sanitizeSessionName(value: string): string {
  return slugify(value).slice(0, 20);
}

async function hasCommand(command: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      execFile("sh", ["-lc", `command -v ${command}`], { encoding: "utf8" }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return true;
  } catch {
    return false;
  }
}

export async function discoverAgentProjects(): Promise<AgentWorkspace[]> {
  const discovered: AgentWorkspace[] = [];

  const explicitWorkspaces: AgentWorkspace[] = [
    {
      id: "foundation-pm-core",
      name: "pm-core",
      label: "PM Core Foundation",
      cwd: path.join(OPS_ROOT, "docker-lab-main", "foundation"),
      scope: "foundation",
      description: "Foundation control plane: compose base, routing substrate, interfaces, migrations, and schemas.",
      deployRoot: "/opt/pm-core",
      foundationId: null,
    },
    {
      id: "app-playground",
      name: "Playground",
      label: "Documents Playground",
      cwd: APP_WORKSPACE_ROOT,
      scope: "app",
      description: "Primary user app workspace root. New apps and AI-built projects should live here, not inside rivr-person.",
      foundationId: "foundation-pm-core",
    },
    {
      id: "shared-autobot",
      name: "Autobot",
      label: "Autobot Shared Tooling",
      cwd: path.join(OPS_ROOT, "Autobot"),
      scope: "shared",
      description: "Shared deploy helpers, operator tooling, and cross-app automation scripts.",
      foundationId: "foundation-pm-core",
    },
  ];

  for (const workspace of explicitWorkspaces) {
    if (existsSync(workspace.cwd)) {
      discovered.push(workspace);
    }
  }

  if (!existsSync(APP_WORKSPACE_ROOT)) {
    const registry = await loadWorkspaceRegistry();
    return mergeWorkspaces(discovered, registry.workspaces);
  }

  const entries = await readdir(APP_WORKSPACE_ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;

    const cwd = path.join(APP_WORKSPACE_ROOT, entry.name);
    const pkgPath = path.join(cwd, "package.json");
    const gitPath = path.join(cwd, ".git");
    if (!existsSync(pkgPath) && !existsSync(gitPath)) continue;

    try {
      const packageJson = existsSync(pkgPath)
        ? (JSON.parse(await readFile(pkgPath, "utf8")) as { name?: string })
        : null;
      discovered.push({
        id: `app-${entry.name}`,
        name: entry.name,
        label: entry.name,
        cwd,
        packageName: packageJson?.name ?? null,
        scope: "app",
        description: `App workspace for ${entry.name}. Use this for source edits, local build/test, and app-scoped deploy work.`,
        deployRoot: `/opt/${entry.name}`,
        liveSubdomain: `${entry.name}.camalot.me`,
        foundationId: "foundation-pm-core",
      });
    } catch {
      discovered.push({
        id: `app-${entry.name}`,
        name: entry.name,
        label: entry.name,
        cwd,
        packageName: null,
        scope: "app",
        description: `App workspace for ${entry.name}. Use this for source edits, local build/test, and app-scoped deploy work.`,
        deployRoot: `/opt/${entry.name}`,
        liveSubdomain: `${entry.name}.camalot.me`,
        foundationId: "foundation-pm-core",
      });
    }
  }

  const registry = await loadWorkspaceRegistry();
  const merged = mergeWorkspaces(discovered, registry.workspaces);
  if (JSON.stringify(registry.workspaces) !== JSON.stringify(merged)) {
    await saveWorkspaceRegistry(merged);
  }
  return merged;
}

export async function loadWorkspaceRegistry(): Promise<AgentWorkspaceRegistry> {
  await ensureMetadataStore();
  return loadJsonFile<AgentWorkspaceRegistry>(WORKSPACE_REGISTRY_PATH, {
    version: 1,
    workspaceRoot: OPS_ROOT,
    appWorkspaceRoot: APP_WORKSPACE_ROOT,
    workspaces: [],
    updatedAt: new Date().toISOString(),
  });
}

export async function saveWorkspaceRegistry(workspaces: AgentWorkspace[]): Promise<AgentWorkspaceRegistry> {
  const registry: AgentWorkspaceRegistry = {
    version: 1,
    workspaceRoot: OPS_ROOT,
    appWorkspaceRoot: APP_WORKSPACE_ROOT,
    workspaces: sortWorkspaces(workspaces),
    updatedAt: new Date().toISOString(),
  };
  await saveJsonFile(WORKSPACE_REGISTRY_PATH, registry);
  return registry;
}

export async function upsertWorkspace(workspace: AgentWorkspace): Promise<AgentWorkspaceRegistry> {
  const registry = await loadWorkspaceRegistry();
  const merged = mergeWorkspaces(registry.workspaces, [workspace]);
  return saveWorkspaceRegistry(merged);
}

export async function loadTeamGraph(): Promise<AgentTeamGraph> {
  await ensureMetadataStore();
  return loadJsonFile<AgentTeamGraph>(TEAM_GRAPH_PATH, {
    version: 1,
    roots: [],
    nodes: {},
    updatedAt: new Date().toISOString(),
  });
}

export async function saveTeamGraph(graph: AgentTeamGraph): Promise<AgentTeamGraph> {
  const next = {
    ...graph,
    updatedAt: new Date().toISOString(),
  };
  await saveJsonFile(TEAM_GRAPH_PATH, next);
  return next;
}

async function upsertTeamNodeFromMetadata(paneKey: string, metadata: AgentSessionMetadata) {
  const graph = await loadTeamGraph();
  const nodeId = paneKey;
  graph.nodes[nodeId] = {
    id: nodeId,
    label: metadata.label || paneKey,
    role: metadata.role,
    parentId: metadata.parent ?? null,
    workspaceId: metadata.workspaceId ?? null,
    notes: metadata.notes,
    objective: metadata.objective,
    capabilityIds: metadata.capabilityIds ?? [],
  };
  const roots = Object.values(graph.nodes)
    .filter((node) => !node.parentId || !graph.nodes[node.parentId])
    .map((node) => node.id);
  graph.roots = Array.from(new Set(roots));
  await saveTeamGraph(graph);
}

function assertInsideRoot(root: string, candidate: string) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Requested path is outside the workspace.");
  }
  return resolved;
}

export async function listWorkspaceEntries(workspaceId: string, relativePath = ""): Promise<{
  workspace: AgentWorkspace;
  relativePath: string;
  entries: AgentWorkspaceEntry[];
}> {
  const workspaces = await discoverAgentProjects();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const safeRelative = relativePath.replace(/^\/+/, "");
  const targetPath = assertInsideRoot(workspace.cwd, path.join(workspace.cwd, safeRelative));
  const directoryEntries = await readdir(targetPath, { withFileTypes: true });
  const entries = await Promise.all(
    directoryEntries
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const entryPath = path.join(targetPath, entry.name);
        const entryStat = await stat(entryPath);
        return {
          name: entry.name,
          path: safeRelative ? path.posix.join(safeRelative, entry.name) : entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size: entryStat.size,
        } satisfies AgentWorkspaceEntry;
      }),
  );

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return { workspace, relativePath: safeRelative, entries };
}

export async function readWorkspaceFile(workspaceId: string, relativePath: string): Promise<{
  workspace: AgentWorkspace;
  relativePath: string;
  content: string;
}> {
  const workspaces = await discoverAgentProjects();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const safeRelative = relativePath.replace(/^\/+/, "");
  if (!safeRelative) {
    throw new Error("File path is required.");
  }

  const filePath = assertInsideRoot(workspace.cwd, path.join(workspace.cwd, safeRelative));
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch (error) {
    // Missing context files should not hard-fail Agent HQ UX.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        workspace,
        relativePath: safeRelative,
        content: "",
      };
    }
    throw error;
  }
  if (!fileInfo.isFile()) {
    throw new Error("Requested path is not a file.");
  }
  if (fileInfo.size > 1024 * 1024) {
    throw new Error("File is too large to preview.");
  }

  return {
    workspace,
    relativePath: safeRelative,
    content: await readFile(filePath, "utf8"),
  };
}

export async function writeWorkspaceFile(
  workspaceId: string,
  relativePath: string,
  content: string,
): Promise<{
  workspace: AgentWorkspace;
  relativePath: string;
  size: number;
}> {
  const workspaces = await discoverAgentProjects();
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    throw new Error("Workspace not found.");
  }

  const safeRelative = relativePath.replace(/^\/+/, "");
  if (!safeRelative) {
    throw new Error("File path is required.");
  }

  const filePath = assertInsideRoot(workspace.cwd, path.join(workspace.cwd, safeRelative));
  await mkdir(path.dirname(filePath), { recursive: true });

  const encodedSize = Buffer.byteLength(content, "utf8");
  if (encodedSize > 1024 * 1024) {
    throw new Error("File is too large to save.");
  }

  await writeFile(filePath, content, "utf8");
  return { workspace, relativePath: safeRelative, size: encodedSize };
}

export async function listAgentLaunchers(): Promise<{
  workspaceRoot: string;
  workspaces: AgentWorkspace[];
  launchers: AgentLauncher[];
}> {
  const workspaces = await discoverAgentProjects();
  const claudeInstalled = await hasCommand("claude");
  const codexInstalled = await hasCommand("codex");
  const opencodeInstalled = await hasCommand("opencode");
  return {
    workspaceRoot: OPS_ROOT,
    workspaces,
    launchers: [
      {
        provider: "opencode",
        label: "OpenCode",
        description: "Launch an OpenCode session in the selected app directory.",
        installed: opencodeInstalled,
        defaultCommandTemplate: "opencode",
      },
      {
        provider: "claude",
        label: "Claude",
        description: "Launch a Claude Code session in the selected app directory.",
        installed: claudeInstalled,
        defaultCommandTemplate: "claude --dangerously-skip-permissions",
      },
      {
        provider: "codex",
        label: "Codex",
        description: "Launch a Codex session in the selected app directory.",
        installed: codexInstalled,
        defaultCommandTemplate: "codex",
      },
      {
        provider: "custom",
        label: "Custom",
        description: "Launch any tmux-friendly command template with cwd and label placeholders.",
        installed: true,
        defaultCommandTemplate: "{command}",
      },
    ],
  };
}

export interface LaunchAgentSessionInput {
  provider: AgentLauncherProvider;
  cwd: string;
  displayLabel: string;
  workspaceId?: string;
  commandTemplate?: string;
  role?: AgentRole;
  parent?: string | null;
  notes?: string;
  objective?: string;
  sessionName?: string;
  capabilityIds?: AgentCapability[];
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
}

export interface LaunchAgentSessionResult {
  sessionName: string;
  paneKey: string;
  cwd: string;
  provider: AgentLauncherProvider;
  command: string;
  metadata: AgentSessionMetadata;
}

function defaultCapabilitiesForScope(scope: AgentWorkspaceScope): AgentCapability[] {
  if (scope === "foundation") {
    return ["foundation_read", "deploy"];
  }
  if (scope === "shared") {
    return ["edit", "git"];
  }
  return ["edit", "git", "deploy"];
}

function renderAgentContext(options: {
  sessionName: string;
  workspace: AgentWorkspace | null;
  cwd: string;
  provider: AgentLauncherProvider;
  role: AgentRole;
  objective: string;
  notes: string;
  capabilities: AgentCapability[];
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
  mountedPaths?: string[];
}) {
  const workspace = options.workspace;
  const lines = [
    "# Agent Session Context",
    "",
    `- Session: ${options.sessionName}`,
    `- Provider: ${options.provider}`,
    `- Role: ${options.role}`,
    `- Working directory: ${options.cwd}`,
    `- Workspace: ${workspace?.label ?? path.basename(options.cwd)}`,
    `- Scope: ${workspace?.scope ?? "unknown"}`,
  ];

  if (workspace?.deployRoot) {
    lines.push(`- Server deploy root: ${workspace.deployRoot}`);
  }
  if (workspace?.liveSubdomain) {
    lines.push(`- Live subdomain: ${workspace.liveSubdomain}`);
  }
  lines.push(`- Capabilities: ${options.capabilities.join(", ") || "none"}`);
  if (options.personaId) {
    lines.push(`- Persona context: ${options.personaName ?? options.personaId} (${options.personaId})`);
  }
  if (options.kgScopeSet && options.kgScopeSet.length > 0) {
    lines.push(`- KG scope set: ${options.kgScopeSet.join(", ")}`);
  }
  if (options.mountedPaths && options.mountedPaths.length > 0) {
    lines.push(`- Mounted context paths: ${options.mountedPaths.join(", ")}`);
  }
  lines.push("");
  lines.push("## Operating Model");
  lines.push("- Default to app-scoped work. Do not assume foundation-wide control.");
  lines.push("- Foundation access is explicit and should only be used when the assigned capabilities require it.");
  lines.push("- pm-core is the foundation control plane and routing/runtime layer, not the default cwd for app work.");
  lines.push("- Apps live in their own directories and should be edited, built, tested, and reasoned about in place.");
  lines.push("");
  lines.push("## Objective");
  lines.push(options.objective || "No explicit objective provided.");
  lines.push("");
  lines.push("## Notes");
  lines.push(options.notes || "No extra notes.");
  lines.push("");
  lines.push("## Boundaries");
  if (workspace?.scope === "foundation") {
    lines.push("- You are in a foundation workspace. Be conservative with deploy/runtime operations.");
    lines.push("- Do not modify unrelated app source unless explicitly asked.");
  } else if (workspace?.scope === "app") {
    lines.push("- Work inside this app unless explicitly instructed to touch shared tooling or foundation infra.");
    lines.push("- Treat pm-core as a deploy substrate, not the authoring home for this app.");
  } else {
    lines.push("- Work inside shared tooling unless explicitly instructed to change a specific app.");
  }
  lines.push("");
  lines.push("## Context Loading");
  lines.push("- Read the nearest repo/app CLAUDE.md when present before making large decisions.");
  if (existsSync(SWARM_STATE_LEDGER_PATH)) {
    lines.push(`- Read the shared swarm state ledger at ${SWARM_STATE_LEDGER_PATH} before substantial work.`);
    lines.push("- Use it as the source of truth for current blockers, ownership, runtime facts, deploy state, and verification.");
    lines.push("- Update the ledger after discovering blockers, changing ownership, verifying work, or deploying.");
  }
  lines.push("- Preserve user changes and avoid reverting unrelated work.");
  if (options.personaId) {
    lines.push("- Operate as the assigned persona for this pane.");
    lines.push("- Keep KG operations constrained to the KG scope set unless explicitly elevated.");
  }
  if (options.mountedPaths && options.mountedPaths.length > 0) {
    lines.push("- Treat mounted context paths as explicitly attached working context for this pane.");
    lines.push("- Read the mounted files or inspect the mounted directories when the task depends on them.");
    lines.push("");
    lines.push("## Mounted Context Paths");
    for (const mountedPath of options.mountedPaths) {
      lines.push(`- ${mountedPath}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function launchAgentSession(input: LaunchAgentSessionInput): Promise<LaunchAgentSessionResult> {
  const cwd = path.resolve(input.cwd);
  const workspaces = await discoverAgentProjects();
  const workspace =
    (input.workspaceId ? workspaces.find((candidate) => candidate.id === input.workspaceId) : null) ??
    workspaces.find((candidate) => path.resolve(candidate.cwd) === cwd) ??
    null;
  if (!isInsideAnyWorkspace(cwd)) {
    throw new Error("Launch cwd must be inside the configured workspace root.");
  }
  if (!existsSync(cwd)) {
    if (workspace?.scope === "app") {
      await mkdir(cwd, { recursive: true });
    } else {
      throw new Error(`Launch cwd does not exist: ${cwd}`);
    }
  }
  const provider = input.provider;
  const displayLabel = input.displayLabel.trim();
  if (!displayLabel) {
    throw new Error("displayLabel is required.");
  }

  const baseName = sanitizeSessionName(input.sessionName || `${provider}-${displayLabel}`);
  const uniqueSuffix = Date.now().toString(36).slice(-5);
  const sessionName = `${baseName}-${uniqueSuffix}`.slice(0, 32);
  const defaultTemplate =
    provider === "opencode"
      ? "opencode"
      : provider === "claude"
      ? `${buildClaudeRuntimePrefix()} claude --dangerously-skip-permissions`
      : provider === "codex"
        ? "codex"
        : input.commandTemplate;

  const commandTemplate = input.commandTemplate || defaultTemplate;
  if (!commandTemplate) {
    throw new Error("commandTemplate is required for custom launches.");
  }

  const command = replaceTemplate(commandTemplate, {
    cwd: shellQuote(cwd),
    label: shellQuote(displayLabel),
    provider: shellQuote(provider),
    sessionName: shellQuote(sessionName),
    command: shellQuote(input.commandTemplate ?? ""),
    projectName: shellQuote(path.basename(cwd)),
  });

  await execTmux(["new-session", "-d", "-s", sessionName, "-c", cwd]);

  const paneKey = `${sessionName}:0.0`;
  const capabilityIds =
    input.capabilityIds && input.capabilityIds.length > 0
      ? Array.from(new Set(input.capabilityIds))
      : defaultCapabilitiesForScope(workspace?.scope ?? "app");
  const kgScopeSet = Array.isArray(input.kgScopeSet)
    ? Array.from(
        new Set(
          input.kgScopeSet.filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          ),
        ),
      )
    : [];
  const contextFile = path.join(CONTEXT_DIR, `${sessionName}.md`);
  await writeFile(
    contextFile,
    renderAgentContext({
      sessionName,
      workspace,
      cwd,
      provider,
      role: input.role ?? "worker",
      objective: input.objective ?? "",
      notes: input.notes ?? "",
      capabilities: capabilityIds,
      personaId: input.personaId ?? null,
      personaName: input.personaName,
      kgScopeSet,
      mountedPaths: [],
    }),
    "utf8",
  );

  // Create the session context folder on disk for context-mount files
  const sessionContextDir = await ensureSessionContextFolder(sessionName);

  const metadata = normalizeMetadata({
    role: input.role ?? "worker",
    parent: input.parent ?? null,
    label: displayLabel,
    displayLabel,
    notes: input.notes ?? "",
    objective: input.objective ?? "",
    provider,
    cwd,
    commandTemplate,
    projectName: path.basename(cwd),
    workspaceId: input.workspaceId ?? workspace?.id,
    workspaceScope: workspace?.scope ?? "app",
    capabilityIds,
    contextFile,
    liveSubdomain: workspace?.liveSubdomain ?? undefined,
    personaId: input.personaId ?? null,
    personaName: input.personaName?.trim() || undefined,
    kgScopeSet,
    mountedPaths: [],
  });
  const current = await loadMetadataStore();
  current[paneKey] = metadata;
  await saveMetadataStore(current);

  // Start the requested agent runtime inside an interactive shell pane.
  if (command.trim()) {
    await sendAgentInput(paneKey, command, true);
    if (provider === "claude") {
      await settleClaudeStartup(paneKey);
    }
  }

  const bootstrapPrompt = [
    `Read the session context file at ${contextFile}.`,
    "Adopt it as your operating context for this workspace before doing other work.",
    `Context files may be mounted at ${sessionContextDir}/ — read any files there for additional context.`,
    input.objective ? `Primary objective: ${input.objective}` : "",
    input.personaId
      ? `Use persona context ${input.personaName ?? input.personaId} and keep KG operations inside the declared scope set.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  await sendAgentInput(paneKey, bootstrapPrompt, true);

  return {
    sessionName,
    paneKey,
    cwd,
    provider,
    command,
    metadata,
  };
}

/* ------------------------------------------------------------------ */
/*  Executive Session Persistence                                     */
/* ------------------------------------------------------------------ */

const EXECUTIVE_SESSION_PATH = path.join(DATA_DIR, "executive-session.json");

export async function loadExecutiveSession(): Promise<ExecutiveSession | null> {
  await ensureMetadataStore();
  if (!existsSync(EXECUTIVE_SESSION_PATH)) return null;
  try {
    const raw = await readFile(EXECUTIVE_SESSION_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.id) return null;
    return {
      ...(parsed as ExecutiveSession),
      messages: Array.isArray((parsed as ExecutiveSession).messages) ? (parsed as ExecutiveSession).messages : [],
    };
  } catch {
    return null;
  }
}

export async function saveExecutiveSession(session: ExecutiveSession): Promise<ExecutiveSession> {
  await ensureMetadataStore();
  const updated = {
    ...session,
    messages: Array.isArray(session.messages) ? session.messages : [],
    updatedAt: new Date().toISOString(),
  };
  await writeFile(EXECUTIVE_SESSION_PATH, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
  return updated;
}

export async function appendExecutiveMessages(
  ...messages: Array<Omit<ExecutiveChatMessage, "id" | "createdAt">>
): Promise<ExecutiveSession | null> {
  const session = await loadExecutiveSession();
  if (!session || session.state !== "active") return null;
  const stamped = messages.map((message) => ({
    id: `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    ...message,
  }));
  session.messages = [...session.messages, ...stamped];
  return saveExecutiveSession(session);
}

/**
 * Determine whether the executive's tmux pane is still alive.
 * Returns `true` if the pane exists in `tmux list-panes`.
 */
export async function isExecutivePaneAlive(paneKey: string): Promise<boolean> {
  try {
    const sessions = await listAgentSessions();
    return sessions.some((s) => paneKeyForSession(s) === paneKey && !s.dead);
  } catch {
    return false;
  }
}

/**
 * Resume or create the executive session.
 * If a persisted session exists and its tmux pane is still alive, return it.
 * Otherwise launch a new executive session and persist it.
 */
export async function resumeOrCreateExecutive(options?: {
  provider?: AgentLauncherProvider;
  cwd?: string;
  personaId?: string | null;
  personaName?: string;
  contextMounts?: ExecutiveContextMount[];
  voiceMode?: "browser" | "clone";
}): Promise<ExecutiveSession> {
  const existing = await loadExecutiveSession();
  if (existing && existing.state === "active") {
    const alive = await isExecutivePaneAlive(existing.paneKey);
    if (alive) {
      // Update context mounts if provided
      if (options?.contextMounts) {
        existing.contextMounts = options.contextMounts;
        return saveExecutiveSession(existing);
      }
      return existing;
    }
    // Pane died — mark as terminated so we create a fresh one.
    existing.state = "terminated";
    await saveExecutiveSession(existing);
  }

  const provider = options?.provider ?? "claude";
  const cwd = options?.cwd ?? process.cwd();
  const label = "Executive";
  const now = new Date().toISOString();
  const sessionId = `exec-${Date.now().toString(36)}`;

  const result = await launchAgentSession({
    provider,
    cwd,
    displayLabel: label,
    role: "executive",
    objective: "You are the executive orchestrator for this sovereign instance. Manage child agents, coordinate work across workspaces, and maintain session continuity.",
    notes: "Persistent executive session. Resume context from prior transcript when possible.",
    personaId: options?.personaId ?? null,
    personaName: options?.personaName,
    capabilityIds: ["edit", "git", "deploy", "kg_read", "kg_write"],
  });

  const session: ExecutiveSession = {
    id: sessionId,
    tmuxSession: result.sessionName,
    paneKey: result.paneKey,
    provider,
    cwd,
    label,
    state: "active",
    contextMounts: options?.contextMounts ?? [],
    personaId: options?.personaId ?? null,
    personaName: options?.personaName,
    voiceMode: options?.voiceMode,
    childPaneKeys: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };

  return saveExecutiveSession(session);
}

/**
 * Register a child pane under the executive session.
 */
export async function registerChildSession(childPaneKey: string): Promise<ExecutiveSession | null> {
  const session = await loadExecutiveSession();
  if (!session || session.state !== "active") return null;
  if (!session.childPaneKeys.includes(childPaneKey)) {
    session.childPaneKeys.push(childPaneKey);
    return saveExecutiveSession(session);
  }
  return session;
}

/**
 * Update context mounts on the executive session.
 */
export async function updateExecutiveContextMounts(
  mounts: ExecutiveContextMount[],
): Promise<ExecutiveSession | null> {
  const session = await loadExecutiveSession();
  if (!session || session.state !== "active") return null;
  session.contextMounts = mounts;
  return saveExecutiveSession(session);
}

/**
 * Terminate the executive session (mark state, leave tmux for cleanup).
 */
export async function terminateExecutiveSession(): Promise<ExecutiveSession | null> {
  const session = await loadExecutiveSession();
  if (!session) return null;
  session.state = "terminated";
  return saveExecutiveSession(session);
}
