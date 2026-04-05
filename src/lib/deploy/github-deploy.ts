/**
 * GitHub deploy integration for the site builder.
 *
 * On shared instances where direct host deployment is forbidden, the site
 * builder pushes generated files to the user's connected GitHub repository.
 * From there, the user's own CI/CD pipeline (GitHub Actions, Vercel,
 * Netlify, etc.) handles the actual deployment to their custom URL.
 *
 * This module NEVER touches the shared host filesystem or Docker runtime.
 *
 * Key exports:
 * - `pushSiteToGitHub()` — commit and push site files to a GitHub repo
 * - `getDeployStatus()` — check the latest deploy/workflow status
 * - `connectGitHubRepo()` — store a GitHub repo connection in user settings
 * - `getGitHubConnection()` — retrieve stored connection for a user
 * - `disconnectGitHubRepo()` — remove stored connection
 */

import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = 'https://api.github.com';

const COMMIT_AUTHOR_NAME = 'Rivr Site Builder';
const COMMIT_AUTHOR_EMAIL = 'builder@rivr.social';

const GITHUB_CONNECTION_SETTING_KEY = 'github_deploy_connection';

/** Maximum number of files per commit to avoid API limits. */
const MAX_FILES_PER_COMMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubConnection {
  repoOwner: string;
  repoName: string;
  branch: string;
  token: string;
  /** Optional subdirectory within the repo for site files. */
  basePath: string;
  /** When the connection was established. */
  connectedAt: string;
}

export interface DeployResult {
  success: boolean;
  commitSha: string | null;
  commitUrl: string | null;
  error: string | null;
  filesUpdated: number;
}

export interface DeployStatus {
  repoUrl: string;
  branch: string;
  latestCommitSha: string | null;
  latestCommitMessage: string | null;
  latestCommitDate: string | null;
  workflowRuns: WorkflowRunSummary[];
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
}

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

interface GitHubApiOptions {
  token: string;
  method?: string;
  body?: unknown;
}

async function githubApi<T>(path: string, opts: GitHubApiOptions): Promise<T> {
  const url = path.startsWith('https://') ? path : `${GITHUB_API_BASE}${path}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => 'Unknown error');
    throw new GitHubDeployError(
      `GitHub API ${opts.method || 'GET'} ${path} failed: ${res.status} — ${errText}`,
      res.status,
    );
  }

  return res.json() as Promise<T>;
}

export class GitHubDeployError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GitHubDeployError';
    this.statusCode = statusCode;
  }
}

// ---------------------------------------------------------------------------
// Parse repo URL
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub repo URL into owner and name.
 * Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
 */
export function parseRepoUrl(input: string): { owner: string; name: string } | null {
  const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');

  // Try URL format
  const urlMatch = cleaned.match(
    /(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)/
  );
  if (urlMatch) {
    return { owner: urlMatch[1], name: urlMatch[2] };
  }

  // Try owner/repo format
  const slashMatch = cleaned.match(/^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/);
  if (slashMatch) {
    return { owner: slashMatch[1], name: slashMatch[2] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Core deploy function
// ---------------------------------------------------------------------------

/**
 * Push site files to a GitHub repository by creating a new commit.
 *
 * Uses the GitHub Git Data API to create blobs, a tree, and a commit
 * without needing a local git clone.
 */
export async function pushSiteToGitHub(params: {
  repoOwner: string;
  repoName: string;
  branch: string;
  files: Record<string, string>;
  commitMessage: string;
  token: string;
  basePath?: string;
}): Promise<DeployResult> {
  const { repoOwner, repoName, branch, files, commitMessage, token, basePath } = params;
  const fileEntries = Object.entries(files);

  if (fileEntries.length === 0) {
    return { success: false, commitSha: null, commitUrl: null, error: 'No files to deploy', filesUpdated: 0 };
  }

  if (fileEntries.length > MAX_FILES_PER_COMMIT) {
    return {
      success: false,
      commitSha: null,
      commitUrl: null,
      error: `Too many files (${fileEntries.length}). Maximum is ${MAX_FILES_PER_COMMIT} per commit.`,
      filesUpdated: 0,
    };
  }

  const repoPath = `/repos/${repoOwner}/${repoName}`;

  // 1. Get the current commit SHA for the branch
  const refData = await githubApi<{ object: { sha: string } }>(
    `${repoPath}/git/ref/heads/${branch}`,
    { token },
  );
  const latestCommitSha = refData.object.sha;

  // 2. Get the tree SHA of the latest commit
  const commitData = await githubApi<{ tree: { sha: string } }>(
    `${repoPath}/git/commits/${latestCommitSha}`,
    { token },
  );
  const baseTreeSha = commitData.tree.sha;

  // 3. Create blobs for each file
  const treeEntries: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];

  for (const [filePath, content] of fileEntries) {
    const fullPath = basePath
      ? `${basePath.replace(/\/$/, '')}/${filePath}`
      : filePath;

    const blobData = await githubApi<{ sha: string }>(
      `${repoPath}/git/blobs`,
      {
        token,
        method: 'POST',
        body: {
          content: Buffer.from(content).toString('base64'),
          encoding: 'base64',
        },
      },
    );

    treeEntries.push({
      path: fullPath,
      mode: '100644',
      type: 'blob',
      sha: blobData.sha,
    });
  }

  // 4. Create a new tree
  const newTree = await githubApi<{ sha: string }>(
    `${repoPath}/git/trees`,
    {
      token,
      method: 'POST',
      body: {
        base_tree: baseTreeSha,
        tree: treeEntries,
      },
    },
  );

  // 5. Create a new commit
  const newCommit = await githubApi<{ sha: string; html_url: string }>(
    `${repoPath}/git/commits`,
    {
      token,
      method: 'POST',
      body: {
        message: commitMessage,
        tree: newTree.sha,
        parents: [latestCommitSha],
        author: {
          name: COMMIT_AUTHOR_NAME,
          email: COMMIT_AUTHOR_EMAIL,
          date: new Date().toISOString(),
        },
      },
    },
  );

  // 6. Update the branch reference to point to the new commit
  await githubApi(
    `${repoPath}/git/refs/heads/${branch}`,
    {
      token,
      method: 'PATCH',
      body: { sha: newCommit.sha },
    },
  );

  return {
    success: true,
    commitSha: newCommit.sha,
    commitUrl: `https://github.com/${repoOwner}/${repoName}/commit/${newCommit.sha}`,
    error: null,
    filesUpdated: fileEntries.length,
  };
}

// ---------------------------------------------------------------------------
// Deploy status
// ---------------------------------------------------------------------------

/**
 * Check the latest deploy/workflow status for a GitHub repository.
 */
export async function getDeployStatus(params: {
  repoOwner: string;
  repoName: string;
  branch: string;
  token: string;
}): Promise<DeployStatus> {
  const { repoOwner, repoName, branch, token } = params;
  const repoPath = `/repos/${repoOwner}/${repoName}`;
  const repoUrl = `https://github.com/${repoOwner}/${repoName}`;

  // Get latest commit on branch
  let latestCommitSha: string | null = null;
  let latestCommitMessage: string | null = null;
  let latestCommitDate: string | null = null;

  try {
    const commits = await githubApi<Array<{
      sha: string;
      commit: { message: string; author: { date: string } };
    }>>(
      `${repoPath}/commits?sha=${branch}&per_page=1`,
      { token },
    );
    if (commits.length > 0) {
      latestCommitSha = commits[0].sha;
      latestCommitMessage = commits[0].commit.message;
      latestCommitDate = commits[0].commit.author.date;
    }
  } catch {
    // Branch may not exist yet
  }

  // Get recent workflow runs
  let workflowRuns: WorkflowRunSummary[] = [];
  try {
    const runs = await githubApi<{
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        html_url: string;
      }>;
    }>(
      `${repoPath}/actions/runs?branch=${branch}&per_page=5`,
      { token },
    );
    workflowRuns = runs.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      htmlUrl: run.html_url,
    }));
  } catch {
    // Repo may not have Actions enabled
  }

  return {
    repoUrl,
    branch,
    latestCommitSha,
    latestCommitMessage,
    latestCommitDate,
    workflowRuns,
  };
}

// ---------------------------------------------------------------------------
// Connection management (stored in agent_settings)
// ---------------------------------------------------------------------------

/**
 * Store a GitHub repo connection for a user. The token is stored in the
 * agent's metadata jsonb column under the github_deploy_connection key.
 *
 * SECURITY NOTE: On shared instances this is the ONLY way to deploy —
 * no host access is ever granted.
 */
export async function connectGitHubRepo(params: {
  userId: string;
  repoUrl: string;
  branch: string;
  token: string;
  basePath?: string;
}): Promise<GitHubConnection> {
  const parsed = parseRepoUrl(params.repoUrl);
  if (!parsed) {
    throw new Error(`Invalid GitHub repository URL: ${params.repoUrl}`);
  }

  // Validate the token has access to the repo
  try {
    await githubApi(`/repos/${parsed.owner}/${parsed.name}`, { token: params.token });
  } catch (err) {
    if (err instanceof GitHubDeployError && err.statusCode === 404) {
      throw new Error(
        `Repository ${parsed.owner}/${parsed.name} not found or token lacks access.`
      );
    }
    throw err;
  }

  const connection: GitHubConnection = {
    repoOwner: parsed.owner,
    repoName: parsed.name,
    branch: params.branch || 'main',
    token: params.token,
    basePath: params.basePath || '',
    connectedAt: new Date().toISOString(),
  };

  // Store in the agent's metadata jsonb column
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, params.userId),
  });

  if (!agent) {
    throw new Error('Agent not found.');
  }

  const currentMetadata = (agent.metadata as Record<string, unknown>) || {};
  const updatedMetadata = {
    ...currentMetadata,
    [GITHUB_CONNECTION_SETTING_KEY]: connection,
  };

  await db
    .update(agents)
    .set({ metadata: updatedMetadata, updatedAt: new Date() })
    .where(eq(agents.id, params.userId));

  return connection;
}

/**
 * Retrieve the stored GitHub connection for a user, if any.
 */
export async function getGitHubConnection(userId: string): Promise<GitHubConnection | null> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, userId),
  });

  if (!agent) return null;

  const metadata = agent.metadata as Record<string, unknown> | null;
  if (!metadata) return null;

  const connection = metadata[GITHUB_CONNECTION_SETTING_KEY];
  if (!connection || typeof connection !== 'object') return null;

  const conn = connection as Record<string, unknown>;
  if (!conn.repoOwner || !conn.repoName || !conn.token) return null;

  return {
    repoOwner: conn.repoOwner as string,
    repoName: conn.repoName as string,
    branch: (conn.branch as string) || 'main',
    token: conn.token as string,
    basePath: (conn.basePath as string) || '',
    connectedAt: (conn.connectedAt as string) || '',
  };
}

/**
 * Remove the stored GitHub connection for a user.
 */
export async function disconnectGitHubRepo(userId: string): Promise<void> {
  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, userId),
  });

  if (!agent) return;

  const currentMetadata = (agent.metadata as Record<string, unknown>) || {};
  const { [GITHUB_CONNECTION_SETTING_KEY]: _removed, ...rest } = currentMetadata;

  await db
    .update(agents)
    .set({ metadata: rest, updatedAt: new Date() })
    .where(eq(agents.id, userId));
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/**
 * Test that a GitHub connection is still valid by fetching the repo metadata.
 */
export async function testGitHubConnection(connection: GitHubConnection): Promise<{
  valid: boolean;
  repoFullName: string;
  error: string | null;
}> {
  try {
    const repo = await githubApi<{ full_name: string }>(
      `/repos/${connection.repoOwner}/${connection.repoName}`,
      { token: connection.token },
    );
    return { valid: true, repoFullName: repo.full_name, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      valid: false,
      repoFullName: `${connection.repoOwner}/${connection.repoName}`,
      error: message,
    };
  }
}
