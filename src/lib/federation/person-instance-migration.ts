import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  agents,
  capitalEntries,
  federationEntityMap,
  federationEvents,
  ledger,
  nodeMemberships,
  nodes,
  resources,
  subscriptions,
  walletTransactions,
  wallets,
} from "@/db/schema";

export type PersonInstanceManifest = {
  manifestVersion: "1.0.0";
  exportedAt: string;
  personAgentId: string;
  sourceNode: typeof nodes.$inferSelect | null;
  summary: {
    agentCount: number;
    resourceCount: number;
    ledgerCount: number;
    walletCount: number;
    walletTransactionCount: number;
    capitalEntryCount: number;
    subscriptionCount: number;
    nodeMembershipCount: number;
    federationEventCount: number;
    federationEntityMapCount: number;
  };
  records: {
    agents: Array<typeof agents.$inferSelect>;
    resources: Array<typeof resources.$inferSelect>;
    ledger: Array<typeof ledger.$inferSelect>;
    wallets: Array<typeof wallets.$inferSelect>;
    walletTransactions: Array<typeof walletTransactions.$inferSelect>;
    capitalEntries: Array<typeof capitalEntries.$inferSelect>;
    subscriptions: Array<typeof subscriptions.$inferSelect>;
    nodeMemberships: Array<typeof nodeMemberships.$inferSelect>;
    federationEvents: Array<typeof federationEvents.$inferSelect>;
    federationEntityMap: Array<typeof federationEntityMap.$inferSelect>;
  };
};

type DbClient = ReturnType<typeof drizzle>;

export async function withDatabase<T>(
  databaseUrl: string,
  fn: (db: DbClient) => Promise<T>,
): Promise<T> {
  const sql = postgres(databaseUrl, { max: 1 });
  const db = drizzle(sql);

  try {
    return await fn(db);
  } finally {
    await sql.end();
  }
}

export async function exportPersonInstanceManifest(
  db: DbClient,
  personAgentId: string,
): Promise<PersonInstanceManifest> {
  const personAgents = await db
    .select()
    .from(agents)
    .where(or(eq(agents.id, personAgentId), eq(agents.parentAgentId, personAgentId)));

  if (personAgents.length === 0) {
    throw new Error(`No person/persona agents found for ${personAgentId}`);
  }

  const agentIds = dedupe(personAgents.map((agent) => agent.id));
  const sourceNode =
    (
      await db
        .select()
        .from(nodes)
        .where(
          or(
            eq(nodes.primaryAgentId, personAgentId),
            eq(nodes.ownerAgentId, personAgentId),
          ),
        )
        .limit(1)
    )[0] ?? null;

  const ownedResources = agentIds.length
    ? await db.select().from(resources).where(inArray(resources.ownerId, agentIds))
    : [];
  const resourceIds = dedupe(ownedResources.map((resource) => resource.id));

  const ledgerRows = await exportLedgerRows(db, agentIds, resourceIds);
  const ledgerIds = dedupe(ledgerRows.map((entry) => entry.id));

  const walletRows = agentIds.length
    ? await db.select().from(wallets).where(inArray(wallets.ownerId, agentIds))
    : [];
  const walletIds = dedupe(walletRows.map((wallet) => wallet.id));

  const walletTransactionRows = await exportWalletTransactions(db, walletIds, ledgerIds);
  const walletTransactionIds = new Set(walletTransactionRows.map((row) => row.id));
  const capitalEntryRows = walletIds.length
    ? await db.select().from(capitalEntries).where(inArray(capitalEntries.walletId, walletIds))
    : [];
  const subscriptionRows = agentIds.length
    ? await db.select().from(subscriptions).where(inArray(subscriptions.agentId, agentIds))
    : [];
  const membershipRows = agentIds.length
    ? await db
        .select()
        .from(nodeMemberships)
        .where(
          or(
            inArray(nodeMemberships.memberAgentId, agentIds),
            inArray(nodeMemberships.scopeAgentId, agentIds),
          ),
        )
    : [];

  const federationEventRows = await exportFederationEvents(
    db,
    sourceNode?.id ?? null,
    agentIds,
    resourceIds,
  );
  const federationEntityMapRows = await exportFederationEntityMap(
    db,
    sourceNode?.id ?? null,
    agentIds,
    resourceIds,
  );

  return {
    manifestVersion: "1.0.0",
    exportedAt: new Date().toISOString(),
    personAgentId,
    sourceNode,
    summary: {
      agentCount: personAgents.length,
      resourceCount: ownedResources.length,
      ledgerCount: ledgerRows.length,
      walletCount: walletRows.length,
      walletTransactionCount: walletTransactionRows.length,
      capitalEntryCount: capitalEntryRows.length,
      subscriptionCount: subscriptionRows.length,
      nodeMembershipCount: membershipRows.length,
      federationEventCount: federationEventRows.length,
      federationEntityMapCount: federationEntityMapRows.length,
    },
    records: {
      agents: personAgents,
      resources: ownedResources,
      ledger: ledgerRows,
      wallets: walletRows,
      walletTransactions: walletTransactionRows.map((row) =>
        sanitizeWalletTransaction(row, walletIds),
      ),
      capitalEntries: capitalEntryRows.filter(
        (row) =>
          row.sourceTransactionId == null || walletTransactionIds.has(row.sourceTransactionId),
      ),
      subscriptions: subscriptionRows,
      nodeMemberships: membershipRows,
      federationEvents: federationEventRows,
      federationEntityMap: federationEntityMapRows,
    },
  };
}

export async function importPersonInstanceManifest(
  db: DbClient,
  manifest: PersonInstanceManifest,
): Promise<PersonInstanceManifest["summary"]> {
  await db.transaction(async (tx) => {
    if (manifest.sourceNode) {
      await tx.insert(nodes).values(manifest.sourceNode).onConflictDoNothing();
    }

    if (manifest.records.agents.length > 0) {
      await tx.insert(agents).values(manifest.records.agents).onConflictDoUpdate({
        target: agents.id,
        set: {
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          description: sql`excluded.description`,
          email: sql`excluded.email`,
          passwordHash: sql`excluded.password_hash`,
          emailVerified: sql`excluded.email_verified`,
          visibility: sql`excluded.visibility`,
          groupPasswordHash: sql`excluded.group_password_hash`,
          image: sql`excluded.image`,
          metadata: sql`excluded.metadata`,
          parentId: sql`excluded.parent_id`,
          pathIds: sql`excluded.path_ids`,
          depth: sql`excluded.depth`,
          location: sql`excluded.location`,
          embedding: sql`excluded.embedding`,
          matrixUserId: sql`excluded.matrix_user_id`,
          matrixAccessToken: sql`excluded.matrix_access_token`,
          website: sql`excluded.website`,
          xHandle: sql`excluded.x_handle`,
          instagram: sql`excluded.instagram`,
          linkedin: sql`excluded.linkedin`,
          telegram: sql`excluded.telegram`,
          signalHandle: sql`excluded.signal_handle`,
          phoneNumber: sql`excluded.phone_number`,
          peermeshHandle: sql`excluded.peermesh_handle`,
          peermeshDid: sql`excluded.peermesh_did`,
          peermeshPublicKey: sql`excluded.peermesh_public_key`,
          peermeshManifestId: sql`excluded.peermesh_manifest_id`,
          peermeshManifestUrl: sql`excluded.peermesh_manifest_url`,
          peermeshLinkedAt: sql`excluded.peermesh_linked_at`,
          atprotoHandle: sql`excluded.atproto_handle`,
          atprotoDid: sql`excluded.atproto_did`,
          atprotoLinkedAt: sql`excluded.atproto_linked_at`,
          parentAgentId: sql`excluded.parent_agent_id`,
          failedLoginAttempts: sql`excluded.failed_login_attempts`,
          lockedUntil: sql`excluded.locked_until`,
          sessionVersion: sql`excluded.session_version`,
          totpSecret: sql`excluded.totp_secret`,
          totpEnabled: sql`excluded.totp_enabled`,
          totpRecoveryCodes: sql`excluded.totp_recovery_codes`,
          searchVector: sql`excluded.search_vector`,
          deletedAt: sql`excluded.deleted_at`,
          createdAt: sql`excluded.created_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
    }
    if (manifest.records.resources.length > 0) {
      await tx.insert(resources).values(manifest.records.resources).onConflictDoNothing();
    }
    if (manifest.records.ledger.length > 0) {
      await tx.insert(ledger).values(manifest.records.ledger).onConflictDoNothing();
    }
    if (manifest.records.wallets.length > 0) {
      await tx.insert(wallets).values(manifest.records.wallets).onConflictDoNothing();
    }
    if (manifest.records.walletTransactions.length > 0) {
      await tx
        .insert(walletTransactions)
        .values(manifest.records.walletTransactions)
        .onConflictDoNothing();
    }
    if (manifest.records.capitalEntries.length > 0) {
      await tx.insert(capitalEntries).values(manifest.records.capitalEntries).onConflictDoNothing();
    }
    if (manifest.records.subscriptions.length > 0) {
      await tx.insert(subscriptions).values(manifest.records.subscriptions).onConflictDoNothing();
    }
    if (manifest.records.nodeMemberships.length > 0) {
      await tx.insert(nodeMemberships).values(manifest.records.nodeMemberships).onConflictDoNothing();
    }
    if (manifest.records.federationEvents.length > 0) {
      await tx.insert(federationEvents).values(manifest.records.federationEvents).onConflictDoNothing();
    }
    if (manifest.records.federationEntityMap.length > 0) {
      await tx
        .insert(federationEntityMap)
        .values(manifest.records.federationEntityMap)
        .onConflictDoNothing();
    }
  });

  return manifest.summary;
}

export async function bootstrapLocalPersonInstanceNode(
  db: DbClient,
  input: {
    instanceId: string;
    slug: string;
    baseUrl: string;
    primaryAgentId: string;
    displayName?: string | null;
    publicKey?: string | null;
    storageNamespace?: string | null;
    healthCheckUrl?: string | null;
    feeWalletAddress?: string | null;
    capabilities?: unknown[];
    migrationStatus?: "active" | "migrating_out" | "migrating_in" | "archived";
  },
): Promise<typeof nodes.$inferSelect> {
  const existingAgent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, input.primaryAgentId))
    .limit(1);

  if (existingAgent.length === 0) {
    throw new Error(
      `Cannot bootstrap local person instance node because agent ${input.primaryAgentId} does not exist in this database.`,
    );
  }

  const values = {
    id: input.instanceId,
    slug: input.slug.trim().toLowerCase(),
    displayName: input.displayName?.trim() || input.slug.trim().toLowerCase(),
    role: "group" as const,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
    publicKey: input.publicKey ?? null,
    isHosted: true,
    ownerAgentId: input.primaryAgentId,
    metadata: {
      sovereignProfile: true,
      bootstrapSource: "person-instance-bootstrap",
    },
    instanceType: "person" as const,
    primaryAgentId: input.primaryAgentId,
    storageNamespace: input.storageNamespace ?? null,
    capabilities: input.capabilities ?? [{ bespokeUi: true }, { federation: true }, { myprofile: true }],
    healthCheckUrl: input.healthCheckUrl ?? null,
    migrationStatus: input.migrationStatus ?? "active",
    feeWalletAddress: input.feeWalletAddress ?? null,
    updatedAt: new Date(),
  } satisfies Partial<typeof nodes.$inferInsert>;

  const existingNode = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, input.instanceId))
    .limit(1);

  if (existingNode.length > 0) {
    const [updated] = await db
      .update(nodes)
      .set(values)
      .where(eq(nodes.id, input.instanceId))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(nodes)
    .values({
      ...values,
      createdAt: new Date(),
    })
    .returning();

  return created;
}

export async function savePersonInstanceManifest(
  manifest: PersonInstanceManifest,
  outputPath: string,
): Promise<string> {
  const absolutePath = resolve(outputPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return absolutePath;
}

export async function loadPersonInstanceManifest(
  inputPath: string,
): Promise<PersonInstanceManifest> {
  const raw = await readFile(resolve(inputPath), "utf8");
  return JSON.parse(raw) as PersonInstanceManifest;
}

async function exportLedgerRows(
  db: DbClient,
  agentIds: string[],
  resourceIds: string[],
): Promise<Array<typeof ledger.$inferSelect>> {
  if (agentIds.length === 0 && resourceIds.length === 0) return [];

  const conditions = [];
  if (agentIds.length > 0) {
    conditions.push(inArray(ledger.subjectId, agentIds));
    conditions.push(inArray(ledger.objectId, agentIds));
  }
  if (resourceIds.length > 0) {
    conditions.push(inArray(ledger.resourceId, resourceIds));
    conditions.push(inArray(ledger.objectId, resourceIds));
  }

  return db.select().from(ledger).where(or(...conditions));
}

async function exportWalletTransactions(
  db: DbClient,
  walletIds: string[],
  ledgerIds: string[],
): Promise<Array<typeof walletTransactions.$inferSelect>> {
  if (walletIds.length === 0 && ledgerIds.length === 0) return [];

  const conditions = [];
  if (walletIds.length > 0) {
    conditions.push(inArray(walletTransactions.fromWalletId, walletIds));
    conditions.push(inArray(walletTransactions.toWalletId, walletIds));
  }
  if (ledgerIds.length > 0) {
    conditions.push(inArray(walletTransactions.ledgerEntryId, ledgerIds));
  }

  return db.select().from(walletTransactions).where(or(...conditions));
}

async function exportFederationEvents(
  db: DbClient,
  sourceNodeId: string | null,
  agentIds: string[],
  resourceIds: string[],
): Promise<Array<typeof federationEvents.$inferSelect>> {
  const conditions = [];
  if (sourceNodeId) {
    conditions.push(eq(federationEvents.originNodeId, sourceNodeId));
  }
  if (agentIds.length > 0) {
    conditions.push(inArray(federationEvents.actorId, agentIds));
    conditions.push(and(eq(federationEvents.entityType, "agent"), inArray(federationEvents.entityId, agentIds)));
  }
  if (resourceIds.length > 0) {
    conditions.push(and(eq(federationEvents.entityType, "resource"), inArray(federationEvents.entityId, resourceIds)));
  }

  if (conditions.length === 0) return [];
  return db.select().from(federationEvents).where(or(...conditions));
}

async function exportFederationEntityMap(
  db: DbClient,
  sourceNodeId: string | null,
  agentIds: string[],
  resourceIds: string[],
): Promise<Array<typeof federationEntityMap.$inferSelect>> {
  const conditions = [];
  if (sourceNodeId) {
    conditions.push(eq(federationEntityMap.originNodeId, sourceNodeId));
  }
  if (agentIds.length > 0) {
    conditions.push(and(eq(federationEntityMap.entityType, "agent"), inArray(federationEntityMap.localEntityId, agentIds)));
  }
  if (resourceIds.length > 0) {
    conditions.push(and(eq(federationEntityMap.entityType, "resource"), inArray(federationEntityMap.localEntityId, resourceIds)));
  }

  if (conditions.length === 0) return [];
  return db.select().from(federationEntityMap).where(or(...conditions));
}

function sanitizeWalletTransaction(
  row: typeof walletTransactions.$inferSelect,
  walletIds: string[],
): typeof walletTransactions.$inferSelect {
  const walletIdSet = new Set(walletIds);
  return {
    ...row,
    fromWalletId: row.fromWalletId && walletIdSet.has(row.fromWalletId) ? row.fromWalletId : null,
    toWalletId: row.toWalletId && walletIdSet.has(row.toWalletId) ? row.toWalletId : null,
  };
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}
