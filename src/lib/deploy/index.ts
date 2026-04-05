/**
 * Deploy module barrel export.
 *
 * Re-exports the capability model, GitHub deploy integration, and
 * related types for convenient imports.
 */

export {
  getDeployCapability,
  resetDeployCapability,
  assertCapability,
  assertSovereign,
  hasCapability,
  CapabilityDeniedError,
  type InstanceDeployCapability,
  type DeployMethod,
} from './capability';

export {
  pushSiteToGitHub,
  getDeployStatus,
  connectGitHubRepo,
  getGitHubConnection,
  disconnectGitHubRepo,
  testGitHubConnection,
  parseRepoUrl,
  GitHubDeployError,
  type GitHubConnection,
  type DeployResult,
  type DeployStatus,
  type WorkflowRunSummary,
} from './github-deploy';
