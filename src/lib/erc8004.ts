import { getInstanceConfig } from "@/lib/federation/instance-config";

type Erc8004AgentLike = {
  id: string;
  name: string;
  description?: string | null;
  image?: string | null;
  parentAgentId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type Erc8004Registration = {
  standard: "erc-8004";
  version: "0.1.0";
  implementation: "offchain-compat";
  agentId: string;
  parentAgentId: string | null;
  name: string;
  username: string | null;
  description: string | null;
  imageUrl: string | null;
  agentRegistry: string;
  agentURI: string;
  registrationFileUrl: string;
  endpoints: {
    mcpDiscovery: string;
    mcpRpc: string;
    profile: string;
    manifest: string;
  };
  instance: {
    instanceId: string;
    instanceType: string;
    instanceSlug: string;
    baseUrl: string;
  };
};

function getUsername(agent: Pick<Erc8004AgentLike, "metadata">): string | null {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const username = metadata.username;
  return typeof username === "string" && username.trim().length > 0 ? username.trim() : null;
}

function getDescription(agent: Pick<Erc8004AgentLike, "description" | "metadata">): string | null {
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const bio = metadata.bio;
  if (typeof bio === "string" && bio.trim().length > 0) return bio.trim();
  return agent.description ?? null;
}

function getImageUrl(agent: Pick<Erc8004AgentLike, "image">): string | null {
  return agent.image ?? null;
}

export function buildErc8004Registration(params: {
  agent: Erc8004AgentLike;
  profileUrl: string;
  manifestUrl: string;
  registrationFileUrl: string;
}): Erc8004Registration {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const username = getUsername(params.agent);

  return {
    standard: "erc-8004",
    version: "0.1.0",
    implementation: "offchain-compat",
    agentId: params.agent.id,
    parentAgentId: params.agent.parentAgentId ?? null,
    name: params.agent.name,
    username,
    description: getDescription(params.agent),
    imageUrl: getImageUrl(params.agent),
    agentRegistry: `rivr:${config.instanceId}:${params.agent.id}`,
    agentURI: params.registrationFileUrl,
    registrationFileUrl: params.registrationFileUrl,
    endpoints: {
      mcpDiscovery: `${baseUrl}/.well-known/mcp`,
      mcpRpc: `${baseUrl}/api/mcp`,
      profile: params.profileUrl,
      manifest: params.manifestUrl,
    },
    instance: {
      instanceId: config.instanceId,
      instanceType: config.instanceType,
      instanceSlug: config.instanceSlug,
      baseUrl,
    },
  };
}
