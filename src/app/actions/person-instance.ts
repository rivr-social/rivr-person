"use server";

import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  buildNextPersonInstanceSetupMetadata,
  buildPersonInstanceSetupState,
  mergePersonInstanceVerification,
  type PersonInstanceSetupCheck,
  type PersonInstanceSetupState,
  type PersonInstanceSetupVerification,
} from "@/lib/person-instance-setup";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { getInstanceConfig } from "@/lib/federation/instance-config";

type SaveSetupInput = {
  targetDomain: string;
  username: string;
  notes?: string;
};

type SetupResult = {
  success: boolean;
  error?: string;
  data?: PersonInstanceSetupState;
};

function fallbackUsername(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "-") || "user";
}

async function loadCurrentAgent() {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: "You must be logged in." } as const;
  }

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  if (!agent) {
    return { error: "Your profile could not be loaded." } as const;
  }

  return { session, agent } as const;
}

export async function getMyPersonInstanceSetupAction(): Promise<SetupResult> {
  const loaded = await loadCurrentAgent();
  if ("error" in loaded) return { success: false, error: loaded.error };

  const metadata =
    loaded.agent.metadata && typeof loaded.agent.metadata === "object" && !Array.isArray(loaded.agent.metadata)
      ? (loaded.agent.metadata as Record<string, unknown>)
      : {};

  return {
    success: true,
    data: buildPersonInstanceSetupState({
      metadata,
      fallbackName: loaded.agent.name,
      fallbackUsername:
        typeof metadata.username === "string" && metadata.username
          ? metadata.username
          : fallbackUsername(loaded.agent.name),
      agentId: loaded.agent.id,
    }),
  };
}

export async function saveMyPersonInstanceSetupAction(input: SaveSetupInput): Promise<SetupResult> {
  const loaded = await loadCurrentAgent();
  if ("error" in loaded) return { success: false, error: loaded.error };

  const targetDomain = input.targetDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!targetDomain || !targetDomain.includes(".")) {
    return { success: false, error: "Enter a valid target domain such as rivr.example.com." };
  }

  const username = input.username.trim().toLowerCase();
  if (!username) {
    return { success: false, error: "Username is required for public profile resolution." };
  }

  const metadata =
    loaded.agent.metadata && typeof loaded.agent.metadata === "object" && !Array.isArray(loaded.agent.metadata)
      ? (loaded.agent.metadata as Record<string, unknown>)
      : {};

  const nextMetadata = buildNextPersonInstanceSetupMetadata({
    metadata,
    targetDomain,
    username,
    notes: input.notes,
  });

  const [updated] = await db
    .update(agents)
    .set({
      metadata: nextMetadata,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, loaded.agent.id))
    .returning({
      id: agents.id,
      name: agents.name,
      metadata: agents.metadata,
    });

  revalidatePath("/settings");
  revalidatePath("/profile");

  const updatedMetadata =
    updated.metadata && typeof updated.metadata === "object" && !Array.isArray(updated.metadata)
      ? (updated.metadata as Record<string, unknown>)
      : {};

  return {
    success: true,
    data: buildPersonInstanceSetupState({
      metadata: updatedMetadata,
      fallbackName: updated.name,
      fallbackUsername: username,
      agentId: updated.id,
    }),
  };
}

export async function verifyMyPersonInstanceSetupAction(): Promise<SetupResult> {
  const loaded = await loadCurrentAgent();
  if ("error" in loaded) return { success: false, error: loaded.error };

  const metadata =
    loaded.agent.metadata && typeof loaded.agent.metadata === "object" && !Array.isArray(loaded.agent.metadata)
      ? (loaded.agent.metadata as Record<string, unknown>)
      : {};

  const setup = buildPersonInstanceSetupState({
    metadata,
    fallbackName: loaded.agent.name,
    fallbackUsername:
      typeof metadata.username === "string" && metadata.username
        ? metadata.username
        : fallbackUsername(loaded.agent.name),
    agentId: loaded.agent.id,
  });

  if (!setup.targetBaseUrl || !setup.username) {
    return { success: false, error: "Save a target domain and username first." };
  }

  const config = getInstanceConfig();
  const checks: PersonInstanceSetupCheck[] = [];

  async function probe(label: string, url: string, expectedStatus: number[] = [200]) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      checks.push({
        id: label.toLowerCase().replace(/\s+/g, "-"),
        label,
        status: expectedStatus.includes(response.status) ? "ok" : "error",
        detail: `${response.status} ${url}`,
      });
    } catch (error) {
      checks.push({
        id: label.toLowerCase().replace(/\s+/g, "-"),
        label,
        status: "error",
        detail: error instanceof Error ? error.message : `Unable to reach ${url}`,
      });
    }
  }

  await probe("Target health", `${setup.targetBaseUrl}/api/health`);
  await probe("Public profile bundle", `${setup.targetBaseUrl}/api/profile/${encodeURIComponent(setup.username)}`);
  await probe("Public profile manifest", `${setup.targetBaseUrl}/api/profile/${encodeURIComponent(setup.username)}/manifest`);
  await probe("My profile gate", `${setup.targetBaseUrl}/api/myprofile`, [401]);

  try {
    const registryUrl = config.registryUrl || `${config.baseUrl.replace(/\/+$/, "")}/api/federation/registry`;
    const resolution = await resolveHomeInstance(loaded.agent.id);
    checks.push({
      id: "home-instance-resolution",
      label: "Home instance resolution",
      status: resolution.baseUrl.replace(/\/+$/, "") === setup.targetBaseUrl.replace(/\/+$/, "") ? "ok" : "warning",
      detail: `${resolution.baseUrl} via ${registryUrl}`,
    });
  } catch (error) {
    checks.push({
      id: "home-instance-resolution",
      label: "Home instance resolution",
      status: "error",
      detail: error instanceof Error ? error.message : "Could not resolve home instance",
    });
  }

  const verification: PersonInstanceSetupVerification = {
    checkedAt: new Date().toISOString(),
    checks,
  };

  const nextMetadata = mergePersonInstanceVerification({
    metadata,
    verification,
  });

  const [updated] = await db
    .update(agents)
    .set({
      metadata: nextMetadata,
      updatedAt: new Date(),
    })
    .where(eq(agents.id, loaded.agent.id))
    .returning({
      id: agents.id,
      name: agents.name,
      metadata: agents.metadata,
    });

  revalidatePath("/settings");

  const updatedMetadata =
    updated.metadata && typeof updated.metadata === "object" && !Array.isArray(updated.metadata)
      ? (updated.metadata as Record<string, unknown>)
      : {};

  return {
    success: true,
    data: buildPersonInstanceSetupState({
      metadata: updatedMetadata,
      fallbackName: updated.name,
      fallbackUsername: setup.username,
      agentId: updated.id,
    }),
  };
}
