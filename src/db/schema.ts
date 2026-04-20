/**
 * Canonical Drizzle schema for the RIVR data platform.
 *
 * Purpose:
 * - Defines all PostgreSQL tables, enums, indices, and relation mappings.
 * - Encodes application business domains: identity graph, resources, ledger, federation, email, billing, and wallets.
 * - Provides inferred TypeScript types for read/write operations.
 *
 * Key exports:
 * - Table models such as `agents`, `resources`, `ledger`, `nodes`, and `wallets`.
 * - Enum definitions used by constraints and domain-level business rules.
 * - Relation definitions used by Drizzle for typed joins.
 * - Inferred `Select`/`Insert` type aliases for service-layer type safety.
 *
 * Dependencies:
 * - `drizzle-orm/pg-core` for table/column/index/type builders.
 * - `drizzle-orm` for relation declarations.
 * - PostgreSQL extensions expected by migrations: PostGIS (`geometry`) and pgvector.
 */
import {
  pgTable,
  pgEnum,
  text,
  timestamp,
  jsonb,
  bigint,
  integer,
  doublePrecision,
  vector,
  index,
  uniqueIndex,
  boolean,
  uuid,
  customType,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Custom tsvector type for full-text search columns.
 * Legacy — the app uses pgvector embeddings instead.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return value as string;
  },
});

/**
 * Custom PostGIS geometry type for spatial data
 * Configuration pattern:
 * - Stores all points in SRID 4326 (WGS84) for consistent geospatial querying.
 * - Converts driver payloads from WKT or WKB into a normalized Point structure.
 */
export const geometry = customType<{
  data: {
    type: 'Point' | 'LineString' | 'Polygon' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
    coordinates: number[] | number[][] | number[][][];
  };
  driverData: string;
}>({
  dataType() {
    return 'geometry(Point, 4326)';
  },
  toDriver(value) {
    return `SRID=4326;POINT(${value.coordinates[0]} ${value.coordinates[1]})`;
  },
  fromDriver(value) {
    // Guard against null, undefined, or non-string values from the driver
    if (value == null || typeof value !== 'string') {
      return {
        type: 'Point' as const,
        coordinates: [0, 0],
      };
    }

    // Handle WKT text format: POINT(lon lat)
    const wktMatch = value.match(/POINT\(([^ ]+) ([^ ]+)\)/);
    if (wktMatch) {
      return {
        type: 'Point' as const,
        coordinates: [parseFloat(wktMatch[1]), parseFloat(wktMatch[2])],
      };
    }

    // Handle WKB hex format returned by PostGIS (e.g., 0101000020E6100000...).
    // Security note: parsing is constrained to expected point payload shape and
    // falls back to a safe default when the value is malformed/unexpected.
    // WKB for Point with SRID 4326: 01 01000020 E6100000 <x:float64LE> <y:float64LE>
    if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 42) {
      const buf = Buffer.from(value, 'hex');
      // Byte 0: endianness (01 = little-endian)
      const isLittleEndian = buf[0] === 1;
      // Read coordinates: offset depends on whether SRID is present
      // With SRID (type flag 0x20000001): header is 1+4+4 = 9 bytes, then x,y each 8 bytes
      // Without SRID (type flag 0x00000001): header is 1+4 = 5 bytes, then x,y each 8 bytes
      let offset: number;
      if (isLittleEndian) {
        const typeFlag = buf.readUInt32LE(1);
        offset = (typeFlag & 0x20000000) ? 9 : 5;
      } else {
        const typeFlag = buf.readUInt32BE(1);
        offset = (typeFlag & 0x20000000) ? 9 : 5;
      }
      const x = isLittleEndian ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset);
      const y = isLittleEndian ? buf.readDoubleLE(offset + 8) : buf.readDoubleBE(offset + 8);
      return {
        type: 'Point' as const,
        coordinates: [x, y],
      };
    }

    // If location is null/empty, return a default
    return {
      type: 'Point' as const,
      coordinates: [0, 0],
    };
  },
});

/**
 * Domain enums used to constrain state transitions and business vocabulary at the DB layer.
 */
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'trialing',
  'unpaid',
  'paused',
]);

export const membershipTierEnum = pgEnum('membership_tier', [
  'basic',
  'host',
  'seller',
  'organizer',
  'steward',
]);

export const visibilityLevelEnum = pgEnum('visibility_level', [
  'public',   // anyone, including federated visitors
  'locale',   // anyone sharing a locale in the pathIds hierarchy
  'members',  // only agents with active belong/join edge to the owning group
  'private',  // only the owner or agents with explicit grant
  'hidden',   // not discoverable; only explicit grants/ownership
]);

export const nodeRoleEnum = pgEnum('node_role', [
  'group',
  'locale',
  'basin',
  'global',
]);

export const peerTrustStateEnum = pgEnum('peer_trust_state', [
  'pending',
  'trusted',
  'blocked',
]);

export const nodeMembershipScopeEnum = pgEnum('node_membership_scope', [
  'group',
  'locale',
  'basin',
]);

export const nodeMembershipStatusEnum = pgEnum('node_membership_status', [
  'pending',
  'active',
  'suspended',
]);

export const instanceTypeEnum = pgEnum("instance_type", [
  "global", "person", "group", "locale", "region",
]);

/**
 * Instance operating mode for an individual agent record.
 *
 * - `sovereign`: the agent lives on a home-server sovereign deployment
 *   (e.g. `rivr.camalot.me`). Seed phrase / recovery key material is
 *   generated client-side and only its public half is stored here.
 * - `hosted-federated`: the agent lives on a shared hosted global
 *   deployment. Global is the credential authority. No seed phrase UI
 *   or recovery key material is issued for this class.
 *
 * Federation-auth MVP (#11 / #18) — see `getInstanceMode()` in
 * `@/lib/instance-mode` for the server-side helper that reads
 * `RIVR_INSTANCE_MODE` and determines the default for new signups.
 */
export const instanceModeEnum = pgEnum('instance_mode', [
  'hosted-federated',
  'sovereign',
]);

export const migrationStatusEnum = pgEnum("migration_status", [
  "active", "migrating_out", "migrating_in", "archived",
]);

export const federationEventStatusEnum = pgEnum('federation_event_status', [
  'queued',
  'exported',
  'imported',
  'failed',
]);

/**
 * Lifecycle marker for rows in the `credential_sync_queue` table.
 *
 * - `pending`  : awaiting (or retrying) delivery to global. Picked up by
 *                the drain worker once `last_attempt_at` is stale enough.
 * - `synced`   : terminal success. Row is kept for audit/history.
 * - `failed`   : terminal dead-letter after exceeding
 *                `MAX_CREDENTIAL_SYNC_ATTEMPTS`. Requires operator action.
 *
 * Referenced by migration 0038_credential_sync_queue and
 * `src/lib/federation/credential-sync.ts`.
 */
export const credentialSyncStatusEnum = pgEnum('credential_sync_status', [
  'pending',
  'synced',
  'failed',
]);

export const agentTypeEnum = pgEnum('agent_type', [
  'person',
  'organization',
  'project', // legacy compatibility
  'event', // legacy compatibility
  'place', // legacy compatibility
  'system',
  'bot',
  'org',
  'domain',
  'ring',
  'family',
  'guild',
  'community',
]);

export const resourceTypeEnum = pgEnum('resource_type', [
  'document',
  'image',
  'video',
  'audio',
  'link',
  'note',
  'file',
  'dataset',
  'resource',
  'skill',
  'project',
  'job',
  'shift',
  'task',
  'training',
  'place',
  'venue',
  'booking',
  'asset',
  'voucher',
  'currency',
  'thanks_token',
  'listing',
  'proposal',
  'badge',
  'post',
  'event',
  'group',
  'permission_policy',
  'receipt',
]);

export const verbTypeEnum = pgEnum('verb_type', [
  // CRUD
  'create',
  'update',
  'delete',
  'transfer',
  'share',
  'view',
  'clone',
  'merge',
  'split',
  // Economic
  'transact',
  'buy',
  'sell',
  'trade',
  'gift',
  'give',
  'earn',
  'redeem',
  'fund',
  'pledge',
  // Work
  'work',
  'clock_in',
  'clock_out',
  'produce',
  'consume',
  // Governance
  'vote',
  'propose',
  'approve',
  'reject',
  // Structural / Membership
  'join',
  'manage',
  'own',
  'locate',
  'follow',
  'belong',
  'assign',
  'invite',
  'employ',
  'contain',
  // Lifecycle
  'start',
  'complete',
  'cancel',
  'archive',
  'publish',
  // Spatial / Temporal
  'attend',
  'host',
  'schedule',
  // Social
  'endorse',
  'mention',
  'comment',
  'react',
  // Permissions
  'grant',
  'revoke',
  'rent',
  'use',
  'leave',
  'request',
  'refund',
]);

/**
 * Agents table - represents identity and governance actors (people + containers)
 * Supports hierarchical relationships and spatial data
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    type: agentTypeEnum('type').notNull(),
    description: text('description'),
    email: text('email'),

    // Authentication
    passwordHash: text('password_hash'),
    emailVerified: timestamp('email_verified', { withTimezone: true }),

    // Access control
    visibility: visibilityLevelEnum('visibility').default('locale'),
    groupPasswordHash: text('group_password_hash'),

    // Profile
    image: text('image'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    // Hierarchical relationships
    parentId: uuid('parent_id'),
    pathIds: uuid('path_ids').array(),
    depth: integer('depth').default(0).notNull(),

    // Spatial data (PostGIS)
    location: geometry('location'),

    // Vector embeddings for semantic search (all-MiniLM-L6-v2 = 384 dimensions)
    embedding: vector('embedding', { dimensions: 384 }),

    // Matrix integration
    matrixUserId: text('matrix_user_id'),
    matrixAccessToken: text('matrix_access_token'),

    // Social links (dedicated columns for faster queries)
    website: text('website'),
    xHandle: text('x_handle'),
    instagram: text('instagram'),
    linkedin: text('linkedin'),
    telegram: text('telegram'),
    signalHandle: text('signal_handle'),
    phoneNumber: text('phone_number'),

    // PeerMesh federation identity
    peermeshHandle: text('peermesh_handle'),
    peermeshDid: text('peermesh_did'),
    peermeshPublicKey: text('peermesh_public_key'),
    peermeshManifestId: text('peermesh_manifest_id'),
    peermeshManifestUrl: text('peermesh_manifest_url'),
    peermeshLinkedAt: timestamp('peermesh_linked_at', { withTimezone: true }),

    // AT Protocol (Bluesky) identity
    atprotoHandle: text('atproto_handle'),
    atprotoDid: text('atproto_did'),
    atprotoLinkedAt: timestamp('atproto_linked_at', { withTimezone: true }),

    // Persona support: links a persona agent to its parent (real) account
    parentAgentId: uuid('parent_agent_id').references((): any => agents.id, { onDelete: 'cascade' }),

    // Reserved for future use — security & auth columns (added by migration 0020)
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    sessionVersion: integer('session_version').notNull().default(1),
    totpSecret: text('totp_secret'),
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpRecoveryCodes: jsonb('totp_recovery_codes'),

    // Federation-auth foundations (migration 0037_federation_auth_foundations)
    // See `/api/instance/mode`, `getInstanceMode()`, and handoff 2026-04-19
    // "Cameron's Clarifications" #3/#5 for the two-user-class model.
    //
    // instanceMode determines whether seed-phrase/recovery UI is offered to
    // this agent. Defaulted from env `RIVR_INSTANCE_MODE` at signup time;
    // stored per-row so rivr-person can host both classes simultaneously if
    // needed. `null` means the row predates this migration and has not yet
    // been classified — treat such rows as hosted-federated for safety.
    instanceMode: instanceModeEnum('instance_mode'),

    // Public half of the recovery (seed-phrase-derived) keypair.
    // Plaintext seed is NEVER stored server-side — only the public key.
    recoveryPublicKey: text('recovery_public_key'),
    recoveryKeyFingerprint: text('recovery_key_fingerprint'),
    recoveryKeyCreatedAt: timestamp('recovery_key_created_at', { withTimezone: true }),
    recoveryKeyRotatedAt: timestamp('recovery_key_rotated_at', { withTimezone: true }),

    // Monotonic counter bumped on every credential change (password, recovery
    // key rotation). Mirrors the counter held by global in `identity_authority`
    // so the two authorities can detect drift during credential sync.
    credentialVersion: integer('credential_version').notNull().default(1),

    // Legacy tsvector — app uses pgvector embeddings instead
    searchVector: tsvector('search_vector'),

    // Soft delete and timestamps
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Search indices
    index('agents_name_idx').on(table.name),
    uniqueIndex('agents_email_idx').on(table.email),
    index('agents_type_idx').on(table.type),

    // Hierarchical query indices
    index('agents_parent_id_idx').on(table.parentId),
    index('agents_path_ids_idx').on(table.pathIds),

    // Spatial index (GIST for PostGIS)
    index('agents_location_gist_idx').using('gist', table.location),

    // Vector similarity index (HNSW for pgvector)
    index('agents_embedding_hnsw_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),

    // Visibility index
    index('agents_visibility_idx').on(table.visibility),

    // Persona parent lookup
    index('agents_parent_agent_id_idx').on(table.parentAgentId),

    // Federation-auth: segmenting agents by instance operating mode
    index('agents_instance_mode_idx').on(table.instanceMode),

    // Federation-auth: recovery key fingerprint lookup (null-partial)
    uniqueIndex('agents_recovery_key_fingerprint_idx')
      .on(table.recoveryKeyFingerprint)
      .where(sql`${table.recoveryKeyFingerprint} IS NOT NULL`),

    // Soft delete queries
    index('agents_deleted_at_idx').on(table.deletedAt),

    // Timestamp indices
    index('agents_created_at_idx').on(table.createdAt),
  ]
);

/**
 * Shape of a single rich embed attached to a resource (typically a post).
 *
 * - `link`: external URL with OpenGraph metadata (populated from the
 *   `link_previews` cache via POST /api/link-preview).
 * - `internal`: link to another RIVR surface (ring/group/locale/profile/etc.).
 *   Rendered with a RIVR-native card instead of a generic OG card; metadata
 *   comes from local DB lookup, not an outbound fetch.
 * - `video` / `image`: reserved for future platform-specific embeds.
 */
export type ResourceEmbed = {
  url: string;
  kind: 'link' | 'internal' | 'video' | 'image';
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  siteName?: string;
  favicon?: string;
};

/**
 * Resources table - stores documents, files, and other content
 * Includes vector embeddings for semantic search
 */
export const resources = pgTable(
  'resources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    type: resourceTypeEnum('type').notNull(),
    description: text('description'),

    // Content
    content: text('content'),
    contentType: text('content_type'),
    url: text('url'),

    // Storage
    storageKey: text('storage_key'),
    storageProvider: text('storage_provider').default('minio'),
    fileSize: integer('file_size'),

    // Ownership and permissions
    ownerId: uuid('owner_id').notNull().references(() => agents.id),
    isPublic: boolean('is_public').default(false).notNull(), // Deprecated — use visibility column instead. Kept for DB compatibility; no longer written to by server actions.
    visibility: visibilityLevelEnum('visibility').default('members'),

    // Metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    tags: text('tags').array().default([]),
    enteredAccountAt: timestamp('entered_account_at', { withTimezone: true }),

    // Rich link/OpenGraph embeds attached at post time. Rendered below post
    // content in the feed. See `ResourceEmbed` type in this file for shape.
    embeds: jsonb('embeds').$type<ResourceEmbed[]>().default([]).notNull(),

    // Vector embeddings for semantic search (all-MiniLM-L6-v2 = 384 dimensions)
    embedding: vector('embedding', { dimensions: 384 }),

    // Legacy tsvector — app uses pgvector embeddings instead
    searchVector: tsvector('search_vector'),

    // Spatial reference (optional)
    location: geometry('location'),

    // Soft delete and timestamps
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Search indices
    index('resources_name_idx').on(table.name),
    index('resources_type_idx').on(table.type),
    index('resources_owner_id_idx').on(table.ownerId),
    index('resources_tags_idx').on(table.tags),

    // Storage indices
    uniqueIndex('resources_storage_key_idx').on(table.storageKey),
    index('resources_type_owner_entered_account_idx').on(
      table.type,
      table.ownerId,
      table.enteredAccountAt,
    ),

    // Vector similarity index
    index('resources_embedding_hnsw_idx')
      .using('hnsw', table.embedding.op('vector_cosine_ops')),

    // Spatial index
    index('resources_location_gist_idx').using('gist', table.location),

    // Visibility index
    index('resources_visibility_idx').on(table.visibility),

    // Soft delete queries
    index('resources_deleted_at_idx').on(table.deletedAt),

    // Timestamp indices
    index('resources_created_at_idx').on(table.createdAt),
  ]
);

/**
 * Ledger table - immutable log of all actions and transactions
 * Stores the complete history of agent interactions with resources
 */
export const ledger = pgTable(
  'ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),

    // Action details
    verb: verbTypeEnum('verb').notNull(),
    subjectId: uuid('subject_id').notNull().references(() => agents.id),
    objectId: uuid('object_id'),
    objectType: text('object_type'),

    // Transaction metadata
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),

    // Permission state
    isActive: boolean('is_active').default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    role: text('role'), // 'admin', 'member', 'viewer', 'moderator'

    // Predicate privacy — controls who can see this relationship/edge exists.
    // When set, canViewPredicate() checks the linked policy or visibility level.
    visibility: visibilityLevelEnum('visibility').default('public'),
    policyId: uuid('policy_id').references(() => resources.id),

    // Immutable timestamp
    timestamp: timestamp('timestamp', { withTimezone: true }).defaultNow().notNull(),

    // Optional resource reference
    resourceId: uuid('resource_id').references(() => resources.id),

    // Context
    sessionId: text('session_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
  },
  (table) => [
    // Query indices
    index('ledger_verb_idx').on(table.verb),
    index('ledger_subject_id_idx').on(table.subjectId),
    index('ledger_object_id_idx').on(table.objectId),
    index('ledger_resource_id_idx').on(table.resourceId),
    index('ledger_timestamp_idx').on(table.timestamp),
    index('ledger_session_id_idx').on(table.sessionId),

    // Composite indices for common queries
    index('ledger_subject_verb_idx').on(table.subjectId, table.verb),
    index('ledger_object_type_object_id_idx').on(
      table.objectType,
      table.objectId
    ),

    // Permission query indices
    index('ledger_active_subject_verb_idx')
      .on(table.subjectId, table.verb, table.isActive),
    index('ledger_active_object_verb_idx')
      .on(table.objectId, table.verb, table.isActive),
    index('ledger_expires_idx').on(table.expiresAt),

    // Predicate privacy indices
    index('ledger_visibility_idx').on(table.visibility),
    index('ledger_policy_id_idx').on(table.policyId),
  ]
);

/**
 * Nodes table - identifies a deployment/node in federation topology
 */
export const nodes = pgTable(
  'nodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    role: nodeRoleEnum('role').notNull(),
    baseUrl: text('base_url').notNull(),
    publicKey: text('public_key'),
    privateKey: text('private_key'),
    isHosted: boolean('is_hosted').default(true).notNull(),
    ownerAgentId: uuid('owner_agent_id').references(() => agents.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    instanceType: instanceTypeEnum("instance_type").default("global"),
    primaryAgentId: uuid("primary_agent_id").references(() => agents.id),
    storageNamespace: text("storage_namespace"),
    capabilities: jsonb("capabilities").default([]),
    healthCheckUrl: text("health_check_url"),
    lastHealthCheck: timestamp("last_health_check", { withTimezone: true }),
    eventSequence: bigint("event_sequence", { mode: "number" }).default(0),
    migrationStatus: migrationStatusEnum("migration_status").default("active"),
    feeWalletAddress: text("fee_wallet_address"),
  },
  (table) => [
    uniqueIndex('nodes_slug_idx').on(table.slug),
    uniqueIndex('nodes_base_url_idx').on(table.baseUrl),
    index('nodes_role_idx').on(table.role),
    index('nodes_owner_agent_id_idx').on(table.ownerAgentId),
    index('idx_nodes_instance_type').on(table.instanceType),
    index('idx_nodes_primary_agent_id').on(table.primaryAgentId),
    index('idx_nodes_migration_status').on(table.migrationStatus),
  ]
);

/**
 * Node peers - trust relationships for confederation
 */
export const nodePeers = pgTable(
  'node_peers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    localNodeId: uuid('local_node_id').notNull().references(() => nodes.id),
    peerNodeId: uuid('peer_node_id').notNull().references(() => nodes.id),
    trustState: peerTrustStateEnum('trust_state').default('pending').notNull(),
    /** SHA-256 hash of the per-peer shared secret used for API authentication */
    peerSecretHash: text('peer_secret_hash'),
    /** Monotonically increasing version number for credential rotation tracking */
    secretVersion: integer('secret_version').default(1).notNull(),
    /** When the current secret was last rotated */
    secretRotatedAt: timestamp('secret_rotated_at', { withTimezone: true }),
    /** Optional expiry for the current secret; null means no expiry */
    secretExpiresAt: timestamp('secret_expires_at', { withTimezone: true }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('node_peers_unique_pair_idx').on(table.localNodeId, table.peerNodeId),
    index('node_peers_local_node_idx').on(table.localNodeId),
    index('node_peers_peer_node_idx').on(table.peerNodeId),
    index('node_peers_trust_state_idx').on(table.trustState),
  ]
);

/**
 * Membership of agents in node scopes
 */
export const nodeMemberships = pgTable(
  'node_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    nodeId: uuid('node_id').notNull().references(() => nodes.id),
    memberAgentId: uuid('member_agent_id').notNull().references(() => agents.id),
    scope: nodeMembershipScopeEnum('scope').notNull(),
    scopeAgentId: uuid('scope_agent_id').references(() => agents.id),
    role: text('role').default('member').notNull(),
    status: nodeMembershipStatusEnum('status').default('active').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('node_memberships_node_id_idx').on(table.nodeId),
    index('node_memberships_member_agent_id_idx').on(table.memberAgentId),
    index('node_memberships_scope_idx').on(table.scope),
    index('node_memberships_status_idx').on(table.status),
  ]
);

/**
 * Federation outbox/inbox events for cross-node synchronization
 */
export const federationEvents = pgTable(
  'federation_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    originNodeId: uuid('origin_node_id').notNull().references(() => nodes.id),
    targetNodeId: uuid('target_node_id').references(() => nodes.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    eventType: text('event_type').notNull(),
    visibility: visibilityLevelEnum('visibility').default('private').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}),
    signature: text('signature'),
    nonce: text('nonce'),
    eventVersion: integer('event_version'),
    status: federationEventStatusEnum('status').default('queued').notNull(),
    error: text('error'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    sequence: bigint("sequence", { mode: "number" }),  // auto-increment via BIGSERIAL in migration
    actorId: uuid("actor_id").references(() => agents.id),
    correlationId: text("correlation_id"),
    causationId: text("causation_id"),
  },
  (table) => [
    index('federation_events_origin_node_id_idx').on(table.originNodeId),
    index('federation_events_target_node_id_idx').on(table.targetNodeId),
    index('federation_events_status_idx').on(table.status),
    index('federation_events_entity_type_idx').on(table.entityType),
    index('federation_events_created_at_idx').on(table.createdAt),
    uniqueIndex('federation_events_nonce_idx').on(table.nonce),
    index('federation_events_entity_version_idx').on(table.entityType, table.entityId, table.eventVersion),
    index('idx_federation_events_sequence').on(table.sequence),
    index('idx_federation_events_actor_id').on(table.actorId),
    index('idx_federation_events_origin_sequence').on(table.originNodeId, table.sequence),
  ]
);

/**
 * Relations
 */

// Agent relations
export const agentsRelations = relations(agents, ({ one, many }) => ({
  // Self-referential parent-child relationship
  parent: one(agents, {
    fields: [agents.parentId],
    references: [agents.id],
    relationName: 'agent_hierarchy',
  }),
  children: many(agents, {
    relationName: 'agent_hierarchy',
  }),

  // Persona parent-child relationship (persona → parent account)
  parentAgent: one(agents, {
    fields: [agents.parentAgentId],
    references: [agents.id],
    relationName: 'persona_hierarchy',
  }),
  personas: many(agents, {
    relationName: 'persona_hierarchy',
  }),

  // Resources owned by this agent
  resources: many(resources),

  // Ledger entries where this agent is the subject
  ledgerEntries: many(ledger),
}));

// Resource relations
export const resourcesRelations = relations(resources, ({ one, many }) => ({
  // Owner agent
  owner: one(agents, {
    fields: [resources.ownerId],
    references: [agents.id],
  }),

  // Ledger entries for this resource
  ledgerEntries: many(ledger),
}));

// Ledger relations
export const ledgerRelations = relations(ledger, ({ one }) => ({
  // Subject agent (who performed the action)
  subject: one(agents, {
    fields: [ledger.subjectId],
    references: [agents.id],
  }),

  // Optional resource
  resource: one(resources, {
    fields: [ledger.resourceId],
    references: [resources.id],
    relationName: 'ledger_resource',
  }),

  // Optional permission policy controlling visibility of this predicate
  policy: one(resources, {
    fields: [ledger.policyId],
    references: [resources.id],
    relationName: 'ledger_policy',
  }),
}));

export const nodesRelations = relations(nodes, ({ one, many }) => ({
  ownerAgent: one(agents, {
    fields: [nodes.ownerAgentId],
    references: [agents.id],
  }),
  localPeers: many(nodePeers, { relationName: 'local_node_peers' }),
  remotePeers: many(nodePeers, { relationName: 'remote_node_peers' }),
  memberships: many(nodeMemberships),
  outboundEvents: many(federationEvents, { relationName: 'origin_node_events' }),
  inboundEvents: many(federationEvents, { relationName: 'target_node_events' }),
}));

export const nodePeersRelations = relations(nodePeers, ({ one }) => ({
  localNode: one(nodes, {
    fields: [nodePeers.localNodeId],
    references: [nodes.id],
    relationName: 'local_node_peers',
  }),
  peerNode: one(nodes, {
    fields: [nodePeers.peerNodeId],
    references: [nodes.id],
    relationName: 'remote_node_peers',
  }),
}));

export const nodeMembershipsRelations = relations(nodeMemberships, ({ one }) => ({
  node: one(nodes, {
    fields: [nodeMemberships.nodeId],
    references: [nodes.id],
  }),
  member: one(agents, {
    fields: [nodeMemberships.memberAgentId],
    references: [agents.id],
  }),
  scopeAgent: one(agents, {
    fields: [nodeMemberships.scopeAgentId],
    references: [agents.id],
    relationName: 'node_membership_scope_agent',
  }),
}));

export const federationEventsRelations = relations(federationEvents, ({ one }) => ({
  originNode: one(nodes, {
    fields: [federationEvents.originNodeId],
    references: [nodes.id],
    relationName: 'origin_node_events',
  }),
  targetNode: one(nodes, {
    fields: [federationEvents.targetNodeId],
    references: [nodes.id],
    relationName: 'target_node_events',
  }),
  actor: one(agents, {
    fields: [federationEvents.actorId],
    references: [agents.id],
    relationName: 'federation_event_actor',
  }),
}));

/**
 * Federation entity map - maps remote entity IDs to local UUIDs
 * Prevents ID collisions when importing federated data from peer nodes
 */
export const federationEntityMap = pgTable(
  'federation_entity_map',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    originNodeId: uuid('origin_node_id').notNull().references(() => nodes.id),
    externalEntityId: text('external_entity_id').notNull(),
    localEntityId: uuid('local_entity_id').notNull(),
    entityType: text('entity_type', { enum: ['agent', 'resource'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('federation_entity_map_origin_external_type_idx').on(
      table.originNodeId,
      table.externalEntityId,
      table.entityType
    ),
    index('federation_entity_map_local_entity_idx').on(table.localEntityId),
    index('federation_entity_map_origin_node_idx').on(table.originNodeId),
  ]
);

export const federationEntityMapRelations = relations(federationEntityMap, ({ one }) => ({
  originNode: one(nodes, {
    fields: [federationEntityMap.originNodeId],
    references: [nodes.id],
  }),
}));

/**
 * Federation audit log - tracks all federation operations for observability
 * Covers imports, exports, peer connections, credential rotations, and revocations
 */
export const federationAuditLog = pgTable(
  'federation_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: text('event_type').notNull(),
    nodeId: uuid('node_id').references(() => nodes.id),
    peerNodeId: uuid('peer_node_id').references(() => nodes.id),
    federationEventId: uuid('federation_event_id').references(() => federationEvents.id),
    actorId: uuid('actor_id'),
    status: text('status').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('federation_audit_log_event_type_idx').on(table.eventType),
    index('federation_audit_log_node_id_idx').on(table.nodeId),
    index('federation_audit_log_created_at_idx').on(table.createdAt),
    index('federation_audit_log_status_idx').on(table.status),
  ]
);

export const federationAuditLogRelations = relations(federationAuditLog, ({ one }) => ({
  node: one(nodes, {
    fields: [federationAuditLog.nodeId],
    references: [nodes.id],
    relationName: 'audit_log_node',
  }),
  peerNode: one(nodes, {
    fields: [federationAuditLog.peerNodeId],
    references: [nodes.id],
    relationName: 'audit_log_peer_node',
  }),
  federationEvent: one(federationEvents, {
    fields: [federationAuditLog.federationEventId],
    references: [federationEvents.id],
  }),
}));

/**
 * Audit log — append-only record of security-relevant actions.
 * Reserved for future use — not yet wired to application logic.
 * Created by migration 0020_schema_sync.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    eventType: text('event_type').notNull(),
    actorId: uuid('actor_id').references(() => agents.id),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    detail: jsonb('detail').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('audit_log_actor_idx').on(table.actorId),
    index('audit_log_event_type_idx').on(table.eventType),
    index('audit_log_created_at_idx').on(table.createdAt),
  ]
);

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  actor: one(agents, {
    fields: [auditLog.actorId],
    references: [agents.id],
  }),
}));

/**
 * Email verification tokens — stores both email-verify and password-reset tokens.
 * Tokens are single-use and time-bounded.
 */
export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    tokenType: text('token_type').notNull(), // 'email_verification' | 'password_reset'
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    /**
     * Optional per-row metadata. Recovery-seed MFA flows (migration
     * 0039_recovery_seed_ui) stash `{ challengeId, method,
     * attemptsRemaining }` here so reveal / rotate can walk the same
     * token table without a dedicated challenges table.
     */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('email_verification_tokens_token_idx').on(table.token),
    index('email_verification_tokens_agent_id_idx').on(table.agentId),
    index('email_verification_tokens_expires_at_idx').on(table.expiresAt),
    index('email_verification_tokens_token_type_idx').on(table.tokenType),
  ]
);

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({ one }) => ({
  agent: one(agents, {
    fields: [emailVerificationTokens.agentId],
    references: [agents.id],
  }),
}));

/**
 * Email audit log — append-only record of every email sent by the system.
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    recipientEmail: text('recipient_email').notNull(),
    recipientAgentId: uuid('recipient_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    subject: text('subject').notNull(),
    emailType: text('email_type').notNull(), // 'verification' | 'password_reset' | 'login_notification' | 'group_broadcast' | 'system'
    status: text('status').notNull(), // 'sent' | 'failed'
    messageId: text('message_id'),
    error: text('error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('email_log_recipient_agent_id_idx').on(table.recipientAgentId),
    index('email_log_email_type_idx').on(table.emailType),
    index('email_log_status_idx').on(table.status),
    index('email_log_created_at_idx').on(table.createdAt),
  ]
);

export const emailLogRelations = relations(emailLog, ({ one }) => ({
  recipientAgent: one(agents, {
    fields: [emailLog.recipientAgentId],
    references: [agents.id],
  }),
}));

/**
 * Subscriptions table - tracks Stripe subscription state for membership tiers
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    stripeCustomerId: text('stripe_customer_id').notNull(),
    stripeSubscriptionId: text('stripe_subscription_id').notNull(),
    stripePriceId: text('stripe_price_id').notNull(),
    status: subscriptionStatusEnum('status').notNull(),
    membershipTier: membershipTierEnum('membership_tier').notNull(),
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('subscriptions_stripe_subscription_id_idx').on(table.stripeSubscriptionId),
    index('subscriptions_agent_id_idx').on(table.agentId),
    index('subscriptions_stripe_customer_id_idx').on(table.stripeCustomerId),
    index('subscriptions_status_idx').on(table.status),
    index('subscriptions_membership_tier_idx').on(table.membershipTier),
    index('subscriptions_current_period_end_idx').on(table.currentPeriodEnd),
  ]
);

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  agent: one(agents, {
    fields: [subscriptions.agentId],
    references: [agents.id],
  }),
}));

/**
 * Wallet enums
 */
export const walletTypeEnum = pgEnum('wallet_type', ['personal', 'group']);

export const walletTransactionTypeEnum = pgEnum('wallet_transaction_type', [
  'stripe_deposit',
  'p2p_transfer',
  'marketplace_purchase',
  'marketplace_payout',
  'event_ticket',
  'service_fee',
  'group_deposit',
  'group_withdrawal',
  'group_transfer',
  'refund',
  'thanks',
  'eth_record',
  'connect_payout',
]);

export const capitalEntrySettlementStatusEnum = pgEnum('capital_entry_settlement_status', [
  'pending',
  'cleared',
]);

export const chatModeEnum = pgEnum('chat_mode', ['ledger', 'matrix', 'both']);

/**
 * Wallets table - one per agent per type, stores balance in cents
 */
export const wallets = pgTable(
  'wallets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    type: walletTypeEnum('type').notNull().default('personal'),
    balanceCents: integer('balance_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    ethAddress: text('eth_address'),
    stripeCustomerId: text('stripe_customer_id'),
    isFrozen: boolean('is_frozen').notNull().default(false),
    hiddenBurnRemainder: doublePrecision('hidden_burn_remainder').notNull().default(0),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallets_owner_id_type_idx').on(table.ownerId, table.type),
    index('wallets_owner_id_idx').on(table.ownerId),
    index('wallets_eth_address_idx').on(table.ethAddress),
    index('wallets_stripe_customer_id_idx').on(table.stripeCustomerId),
  ]
);

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  owner: one(agents, {
    fields: [wallets.ownerId],
    references: [agents.id],
  }),
  outgoingTransactions: many(walletTransactions, { relationName: 'fromWallet' }),
  incomingTransactions: many(walletTransactions, { relationName: 'toWallet' }),
  capitalEntries: many(capitalEntries),
}));

/**
 * Wallet transactions table - immutable log of all wallet movements
 */
export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: walletTransactionTypeEnum('type').notNull(),
    fromWalletId: uuid('from_wallet_id').references(() => wallets.id),
    toWalletId: uuid('to_wallet_id').references(() => wallets.id),
    amountCents: integer('amount_cents').notNull(),
    feeCents: integer('fee_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    description: text('description'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    ethTxHash: text('eth_tx_hash'),
    referenceType: text('reference_type'),
    referenceId: uuid('reference_id'),
    ledgerEntryId: uuid('ledger_entry_id').references(() => ledger.id),
    status: text('status').notNull().default('completed'),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('wallet_transactions_stripe_pi_idx').on(table.stripePaymentIntentId),
    index('wallet_transactions_from_wallet_id_idx').on(table.fromWalletId),
    index('wallet_transactions_to_wallet_id_idx').on(table.toWalletId),
    index('wallet_transactions_type_idx').on(table.type),
    index('wallet_transactions_status_idx').on(table.status),
    index('wallet_transactions_created_at_idx').on(table.createdAt),
    index('wallet_transactions_reference_idx').on(table.referenceType, table.referenceId),
  ]
);

export const walletTransactionsRelations = relations(walletTransactions, ({ one }) => ({
  fromWallet: one(wallets, {
    fields: [walletTransactions.fromWalletId],
    references: [wallets.id],
    relationName: 'fromWallet',
  }),
  toWallet: one(wallets, {
    fields: [walletTransactions.toWalletId],
    references: [wallets.id],
    relationName: 'toWallet',
  }),
  ledgerEntry: one(ledger, {
    fields: [walletTransactions.ledgerEntryId],
    references: [ledger.id],
  }),
}));

export const capitalEntries = pgTable(
  'capital_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    walletId: uuid('wallet_id').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
    sourceEntryId: uuid('source_entry_id'),
    sourceTransactionId: uuid('source_transaction_id').references(() => walletTransactions.id, { onDelete: 'set null' }),
    amountCents: integer('amount_cents').notNull(),
    remainingCents: integer('remaining_cents').notNull(),
    settlementStatus: capitalEntrySettlementStatusEnum('settlement_status').notNull().default('cleared'),
    availableOn: timestamp('available_on', { withTimezone: true }),
    sourceType: text('source_type').notNull(),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('capital_entries_wallet_id_idx').on(table.walletId),
    index('capital_entries_source_entry_id_idx').on(table.sourceEntryId),
    index('capital_entries_source_transaction_id_idx').on(table.sourceTransactionId),
    index('capital_entries_settlement_status_idx').on(table.settlementStatus),
    index('capital_entries_available_on_idx').on(table.availableOn),
    index('capital_entries_created_at_idx').on(table.createdAt),
  ]
);

export const capitalEntriesRelations = relations(capitalEntries, ({ one }) => ({
  wallet: one(wallets, {
    fields: [capitalEntries.walletId],
    references: [wallets.id],
  }),
  sourceEntry: one(capitalEntries, {
    fields: [capitalEntries.sourceEntryId],
    references: [capitalEntries.id],
    relationName: 'capitalEntrySource',
  }),
  sourceTransaction: one(walletTransactions, {
    fields: [capitalEntries.sourceTransactionId],
    references: [walletTransactions.id],
  }),
}));

/**
 * Group Matrix rooms - maps group agents to their Matrix chat rooms
 * Supports dual-mode (ledger + Matrix) messaging during migration
 */
export const groupMatrixRooms = pgTable(
  'group_matrix_rooms',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupAgentId: uuid('group_agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    matrixRoomId: text('matrix_room_id').notNull(),
    chatMode: chatModeEnum('chat_mode').notNull().default('both'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('group_matrix_rooms_group_agent_id_idx').on(table.groupAgentId),
    uniqueIndex('group_matrix_rooms_matrix_room_id_idx').on(table.matrixRoomId),
  ]
);

export const groupMatrixRoomsRelations = relations(groupMatrixRooms, ({ one }) => ({
  groupAgent: one(agents, {
    fields: [groupMatrixRooms.groupAgentId],
    references: [agents.id],
  }),
}));

/**
 * Contract action shape stored in the actions JSONB array.
 * Each action in the chain has the rule owner as subject.
 * Determiners scope resolution at runtime (any, my, the, that).
 */
export interface ContractAction {
  verb: string;
  objectDeterminer?: string;  // "any" | "my" | "the" | "that" | "a" | "all"
  objectId?: string;
  targetDeterminer?: string;  // "any" | "my" | "the" | "that"
  targetId?: string;          // null resolves via determiner (e.g. "that" = $trigger.subjectId)
  delta?: number;
}

/**
 * Contract rules table - stores WHEN/THEN/IF agreement rules
 * Rules auto-execute via the ledger engine when trigger patterns match.
 * Actions is a JSONB array supporting chained multi-action responses.
 * Determiners provide natural-language scoping (any, my, the, that).
 */
export const contractRules = pgTable(
  'contract_rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    scopeId: uuid('scope_id').references(() => agents.id),

    // Trigger pattern: WHEN [det] [who] [does what] [det] [what]
    triggerSubjectDeterminer: text('trigger_subject_determiner'),  // "any" | "the" | "my"
    triggerSubjectId: uuid('trigger_subject_id'),  // null when det = "any"
    triggerVerb: text('trigger_verb'),
    triggerObjectDeterminer: text('trigger_object_determiner'),    // "any" | "my" | "the" | "that" | "a" | "all"
    triggerObjectId: uuid('trigger_object_id'),

    // Actions: THEN chain — JSONB array with determiners per slot
    actions: jsonb('actions').$type<ContractAction[]>().default([]).notNull(),

    // Optional condition: IF [det] [who] [does what] [det] [what]
    conditionSubjectDeterminer: text('condition_subject_determiner'),
    conditionSubjectId: uuid('condition_subject_id'),
    conditionVerb: text('condition_verb'),
    conditionObjectDeterminer: text('condition_object_determiner'),
    conditionObjectId: uuid('condition_object_id'),

    enabled: boolean('enabled').default(true).notNull(),
    fireCount: integer('fire_count').default(0).notNull(),
    maxFires: integer('max_fires'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('contract_rules_owner_idx').on(table.ownerId),
    index('contract_rules_enabled_idx').on(table.enabled),
    index('contract_rules_trigger_verb_idx').on(table.triggerVerb),
  ]
);

export const contractRulesRelations = relations(contractRules, ({ one }) => ({
  owner: one(agents, {
    fields: [contractRules.ownerId],
    references: [agents.id],
  }),
}));

/**
 * Auth.js (NextAuth v5) tables
 * These tables support OAuth accounts, database sessions, and email verification.
 * The agents table serves as the "users" table for Auth.js via the adapter mapping.
 */

/**
 * Accounts table - stores OAuth provider accounts linked to agents
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    uniqueIndex('accounts_provider_provider_account_id_idx').on(
      table.provider,
      table.providerAccountId
    ),
    index('accounts_user_id_idx').on(table.userId),
  ]
);

/**
 * Sessions table - stores active user sessions for database strategy
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionToken: text('session_token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('sessions_session_token_idx').on(table.sessionToken),
    index('sessions_user_id_idx').on(table.userId),
  ]
);

/**
 * Verification tokens table - stores email verification and magic link tokens
 */
export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('verification_tokens_identifier_token_idx').on(
      table.identifier,
      table.token
    ),
  ]
);

/**
 * Type exports for TypeScript inference.
 * These aliases are the preferred service-layer contract for DB reads/writes.
 */
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

export type Resource = typeof resources.$inferSelect;
export type NewResource = typeof resources.$inferInsert;

export type LedgerEntry = typeof ledger.$inferSelect;
export type NewLedgerEntry = typeof ledger.$inferInsert;

export type AgentType = typeof agentTypeEnum.enumValues[number];
export type ResourceType = typeof resourceTypeEnum.enumValues[number];
export type VerbType = typeof verbTypeEnum.enumValues[number];
export type VisibilityLevel = typeof visibilityLevelEnum.enumValues[number];
export type NodeRole = typeof nodeRoleEnum.enumValues[number];
export type PeerTrustState = typeof peerTrustStateEnum.enumValues[number];
export type FederationEventStatus = typeof federationEventStatusEnum.enumValues[number];

export type NodeRecord = typeof nodes.$inferSelect;
export type NewNodeRecord = typeof nodes.$inferInsert;
export type NodePeerRecord = typeof nodePeers.$inferSelect;
export type NewNodePeerRecord = typeof nodePeers.$inferInsert;
export type NodeMembershipRecord = typeof nodeMemberships.$inferSelect;
export type NewNodeMembershipRecord = typeof nodeMemberships.$inferInsert;
export type FederationEventRecord = typeof federationEvents.$inferSelect;
export type NewFederationEventRecord = typeof federationEvents.$inferInsert;
export type FederationEntityMapRecord = typeof federationEntityMap.$inferSelect;
export type NewFederationEntityMapRecord = typeof federationEntityMap.$inferInsert;

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type SubscriptionStatus = typeof subscriptionStatusEnum.enumValues[number];
export type MembershipTier = typeof membershipTierEnum.enumValues[number];

export type FederationAuditLogRecord = typeof federationAuditLog.$inferSelect;
export type NewFederationAuditLogRecord = typeof federationAuditLog.$inferInsert;

/**
 * MCP provenance log — append-only audit trail for every MCP tool invocation.
 * Records actor, tool, args summary, result status, and timing.
 * Created by migration 0032_mcp_provenance_log.
 */
export const mcpProvenanceLog = pgTable(
  'mcp_provenance_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    toolName: text('tool_name').notNull(),
    actorId: uuid('actor_id').notNull(),
    actorType: text('actor_type').notNull(),
    authMode: text('auth_mode').notNull(),
    controllerId: uuid('controller_id'),
    argsSummary: jsonb('args_summary').$type<Record<string, unknown>>().default({}),
    resultStatus: text('result_status').notNull(),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('mcp_provenance_log_tool_name_idx').on(table.toolName),
    index('mcp_provenance_log_actor_id_idx').on(table.actorId),
    index('mcp_provenance_log_actor_type_idx').on(table.actorType),
    index('mcp_provenance_log_created_at_idx').on(table.createdAt),
    index('mcp_provenance_log_result_status_idx').on(table.resultStatus),
  ]
);

export type McpProvenanceLogRecord = typeof mcpProvenanceLog.$inferSelect;
export type NewMcpProvenanceLogRecord = typeof mcpProvenanceLog.$inferInsert;

export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type NewEmailVerificationToken = typeof emailVerificationTokens.$inferInsert;

export type EmailLogRecord = typeof emailLog.$inferSelect;
export type NewEmailLogRecord = typeof emailLog.$inferInsert;

export type WalletRecord = typeof wallets.$inferSelect;
export type NewWalletRecord = typeof wallets.$inferInsert;
export type WalletTransactionRecord = typeof walletTransactions.$inferSelect;
export type NewWalletTransactionRecord = typeof walletTransactions.$inferInsert;
export type CapitalEntryRecord = typeof capitalEntries.$inferSelect;
export type NewCapitalEntryRecord = typeof capitalEntries.$inferInsert;
export type WalletType = typeof walletTypeEnum.enumValues[number];
export type WalletTransactionType = typeof walletTransactionTypeEnum.enumValues[number];
export type CapitalEntrySettlementStatus = typeof capitalEntrySettlementStatusEnum.enumValues[number];

export type ChatMode = typeof chatModeEnum.enumValues[number];
export type GroupMatrixRoom = typeof groupMatrixRooms.$inferSelect;
export type NewGroupMatrixRoom = typeof groupMatrixRooms.$inferInsert;

export type ContractRule = typeof contractRules.$inferSelect;
export type NewContractRule = typeof contractRules.$inferInsert;

/**
 * Site versions — version history for the bespoke site builder.
 * Each row captures a complete snapshot of all site files at a point in time,
 * enabling lossless rollback to any previous version.
 * Created by migration 0033_site_versions.
 */
export const siteVersions = pgTable(
  'site_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    commitMessage: text('commit_message'),
    /** Full snapshot of all site files as { filename: content } */
    filesSnapshot: jsonb('files_snapshot').$type<Record<string, string>>().notNull(),
    /** What triggered this version: 'deploy', 'save', 'manual' */
    trigger: text('trigger').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('site_versions_agent_id_idx').on(table.agentId),
    index('site_versions_agent_version_idx').on(table.agentId, table.versionNumber),
    index('site_versions_created_at_idx').on(table.createdAt),
  ]
);

export type SiteVersionRecord = typeof siteVersions.$inferSelect;
export type NewSiteVersionRecord = typeof siteVersions.$inferInsert;

/**
 * Domain verification status enum for custom domain configuration.
 * Tracks the lifecycle of a custom domain from initial setup to active use.
 */
export const domainVerificationStatusEnum = pgEnum('domain_verification_status', [
  'pending',   // DNS records not yet verified
  'verified',  // DNS ownership confirmed via TXT record
  'active',    // DNS pointing correctly and domain is serving traffic
]);

/**
 * Domain configurations table - stores custom domain settings for sovereign instances.
 * Each agent (instance owner) may have at most one custom domain configured.
 *
 * Integration note: This table manages the application-level domain lifecycle.
 * Actual Traefik router/certificate configuration must be applied separately
 * on the host (e.g., via deploy agent, SSH, or Traefik dynamic config file).
 */
export const domainConfigs = pgTable(
  'domain_configs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    customDomain: text('custom_domain').notNull(),
    verificationToken: text('verification_token').notNull(),
    verificationStatus: domainVerificationStatusEnum('verification_status').default('pending').notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    traefikConfig: text('traefik_config'),
    traefikConfigGeneratedAt: timestamp('traefik_config_generated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('domain_configs_agent_id_idx').on(table.agentId),
    uniqueIndex('domain_configs_custom_domain_idx').on(table.customDomain),
    index('domain_configs_verification_status_idx').on(table.verificationStatus),
  ]
);

export type DomainConfigRecord = typeof domainConfigs.$inferSelect;
export type NewDomainConfigRecord = typeof domainConfigs.$inferInsert;
export type DomainVerificationStatus = typeof domainVerificationStatusEnum.enumValues[number];

// ---------------------------------------------------------------------------
// Persona approval / audit enums and tables
// ---------------------------------------------------------------------------

export const approvalStatusEnum = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
]);

export const auditDecisionEnum = pgEnum('audit_decision', [
  'auto_allowed',
  'approved',
  'rejected',
  'expired',
]);

export const actionRiskLevelEnum = pgEnum('action_risk_level', [
  'low',
  'medium',
  'high',
]);

/**
 * Persona action approvals — queue of pending/resolved action approvals.
 * Created by migration 0035_persona_approvals.
 */
export const personaActionApprovals = pgTable(
  'persona_action_approvals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personaId: uuid('persona_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    actionPayload: jsonb('action_payload').$type<Record<string, unknown>>().default({}).notNull(),
    riskLevel: actionRiskLevelEnum('risk_level').notNull().default('medium'),
    status: approvalStatusEnum('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => agents.id, { onDelete: 'set null' }),
    resolutionNote: text('resolution_note'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    index('paa_persona_id_idx').on(table.personaId),
    index('paa_status_idx').on(table.status),
    index('paa_risk_level_idx').on(table.riskLevel),
    index('paa_requested_at_idx').on(table.requestedAt),
    index('paa_expires_at_idx').on(table.expiresAt),
    index('paa_persona_status_idx').on(table.personaId, table.status),
  ]
);

export const personaActionApprovalsRelations = relations(personaActionApprovals, ({ one }) => ({
  persona: one(agents, {
    fields: [personaActionApprovals.personaId],
    references: [agents.id],
    relationName: 'persona_approvals',
  }),
  resolver: one(agents, {
    fields: [personaActionApprovals.resolvedBy],
    references: [agents.id],
    relationName: 'approval_resolver',
  }),
}));

/**
 * Persona audit log — append-only log of all persona action decisions.
 * Created by migration 0035_persona_approvals.
 */
export const personaAuditLog = pgTable(
  'persona_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    personaId: uuid('persona_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    actionType: text('action_type').notNull(),
    riskLevel: actionRiskLevelEnum('risk_level').notNull().default('medium'),
    decision: auditDecisionEnum('decision').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
    actorId: uuid('actor_id').references(() => agents.id, { onDelete: 'set null' }),
    approvalId: uuid('approval_id').references(() => personaActionApprovals.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('pal_persona_id_idx').on(table.personaId),
    index('pal_action_type_idx').on(table.actionType),
    index('pal_decision_idx').on(table.decision),
    index('pal_created_at_idx').on(table.createdAt),
    index('pal_persona_created_idx').on(table.personaId, table.createdAt),
  ]
);

export const personaAuditLogRelations = relations(personaAuditLog, ({ one }) => ({
  persona: one(agents, {
    fields: [personaAuditLog.personaId],
    references: [agents.id],
    relationName: 'persona_audit_entries',
  }),
  actor: one(agents, {
    fields: [personaAuditLog.actorId],
    references: [agents.id],
    relationName: 'audit_actor',
  }),
  approval: one(personaActionApprovals, {
    fields: [personaAuditLog.approvalId],
    references: [personaActionApprovals.id],
  }),
}));

export type PersonaActionApprovalRecord = typeof personaActionApprovals.$inferSelect;
export type NewPersonaActionApprovalRecord = typeof personaActionApprovals.$inferInsert;
export type ApprovalStatus = typeof approvalStatusEnum.enumValues[number];
export type ActionRiskLevel = typeof actionRiskLevelEnum.enumValues[number];

export type PersonaAuditLogRecord = typeof personaAuditLog.$inferSelect;
export type NewPersonaAuditLogRecord = typeof personaAuditLog.$inferInsert;
export type AuditDecision = typeof auditDecisionEnum.enumValues[number];

// ---------------------------------------------------------------------------
// Builder data-source bindings
// ---------------------------------------------------------------------------

/**
 * Builder data sources — persisted registry of public data sources the
 * site builder can bind to when generating a live site / workspace.
 * Each row represents one enabled (or disabled) data-source binding for
 * a given agent (user).  The `config` JSONB column carries source-specific
 * parameters (e.g. Solid Pod WebID, public-profile username).
 * Created by migration 0036_builder_data_sources.
 */
export const builderDataSources = pgTable(
  'builder_data_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull(),
    /** myprofile | public-profile | solid-pod | universal-manifest */
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Source-specific config: { username?, webId?, umKind?, umId? } */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('bds_agent_id_idx').on(table.agentId),
    index('bds_agent_kind_idx').on(table.agentId, table.kind),
  ]
);

export type BuilderDataSourceRecord = typeof builderDataSources.$inferSelect;
export type NewBuilderDataSourceRecord = typeof builderDataSources.$inferInsert;

// ---------------------------------------------------------------------------
// Credential sync queue (federation-auth #15)
// ---------------------------------------------------------------------------

/**
 * Dead-letter / retry queue for `credential.updated` federation events that
 * the home instance could not immediately deliver to global (network error,
 * 5xx, 404 while the receiver is still pending on global).
 *
 * Written to by `src/lib/federation/credential-sync.ts` when a POST to
 * `${GLOBAL_BASE_URL}/api/federation/events/import` fails. Drained by
 * `src/app/api/admin/federation/drain-credential-sync-queue/route.ts` (or
 * anything else that calls `drainCredentialSyncQueue()`).
 *
 * Rows are kept for audit/history after reaching a terminal status.
 * Created by migration 0038_credential_sync_queue.
 */
export const credentialSyncQueue = pgTable(
  'credential_sync_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /**
     * Full signed `credential.updated` event: `{ type, agentId,
     * credentialVersion, updatedAt, signature, nonce, signingNodeSlug }`.
     * Persisted verbatim so retries re-deliver the exact original event.
     */
    eventPayload: jsonb('event_payload').$type<Record<string, unknown>>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastError: text('last_error'),
    status: credentialSyncStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('credential_sync_queue_status_idx').on(table.status),
    index('credential_sync_queue_agent_id_idx').on(table.agentId),
    // Drain worker filters by status + last_attempt_at. Compound index keeps
    // the backlog scan index-only as the table grows.
    index('credential_sync_queue_status_last_attempt_idx')
      .on(table.status, table.lastAttemptAt),
  ]
);

export type CredentialSyncQueueRecord = typeof credentialSyncQueue.$inferSelect;
export type NewCredentialSyncQueueRecord = typeof credentialSyncQueue.$inferInsert;
export type CredentialSyncStatus = typeof credentialSyncStatusEnum.enumValues[number];

/**
 * MFA channel used when challenging a user before revealing or rotating
 * their recovery seed phrase.
 *
 * - `email` : reuses the existing SMTP transport (`src/lib/email.ts`).
 * - `sms`   : currently a stubbed provider (`src/lib/recovery-seed-mfa.ts`)
 *             that throws until an external SMS provider is wired; the
 *             enum value exists so the data model does not need a second
 *             migration when SMS becomes available.
 *
 * Referenced by migration 0039_recovery_seed_ui.
 */
export const recoverySeedMethodEnum = pgEnum('recovery_seed_method', [
  'email',
  'sms',
]);

/**
 * Lifecycle stages written to `recovery_seed_audit_log`.
 *
 * - `challenge_issued`   : a fresh email/SMS code was generated and sent.
 * - `challenge_verified` : the user supplied a correct, in-window code.
 * - `challenge_failed`   : wrong code, expired code, or rate-limit hit.
 * - `reveal_succeeded`   : the client surfaced the mnemonic to the user.
 * - `rotate_succeeded`   : a new recovery key pair was registered and the
 *                          old one was moved into `retired_recovery_keys`.
 *
 * Referenced by migration 0039_recovery_seed_ui.
 */
export const recoverySeedEventKindEnum = pgEnum('recovery_seed_event_kind', [
  'challenge_issued',
  'challenge_verified',
  'challenge_failed',
  'reveal_succeeded',
  'rotate_succeeded',
]);

// =============================================================================
// Recovery seed audit + retired keys
// -----------------------------------------------------------------------------
// Implements the Security-tab reveal/rotate flows for sovereign agents.
// See migration 0039_recovery_seed_ui.sql and GitHub issues
// rivr-social/rivr-person#12 #13 #14.
// =============================================================================

/**
 * Append-only audit of recovery-seed reveal/rotate activity.
 *
 * Every meaningful lifecycle transition is recorded here so the user's
 * Security settings view can surface recent reveal attempts, MFA failures,
 * and rotations. Rows are never updated or deleted except via normal agent
 * soft-delete cascade.
 *
 * Written by:
 * - `src/app/api/recovery/challenge/route.ts` (`challenge_issued`)
 * - `src/app/api/recovery/verify-challenge/route.ts` (`challenge_verified` / `challenge_failed`)
 * - `src/app/api/recovery/rotate/route.ts` (`rotate_succeeded`)
 * - Client-side `reveal_succeeded` is posted via
 *   `src/app/api/recovery/audit-reveal/route.ts`.
 */
export const recoverySeedAuditLog = pgTable(
  'recovery_seed_audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    eventKind: recoverySeedEventKindEnum('event_kind').notNull(),
    /** NULL for rotate events that reuse an already-verified challenge. */
    method: recoverySeedMethodEnum('method'),
    /** Short human-readable outcome ("success", "code_expired", ...). */
    outcome: text('outcome'),
    /** Best-effort client IP at the time of the event. */
    ipAddress: text('ip_address'),
    /** Best-effort user-agent string at the time of the event. */
    userAgent: text('user_agent'),
    /** Optional structured context: fingerprint, remainingAttempts, etc. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('recovery_seed_audit_log_agent_id_idx').on(table.agentId),
    index('recovery_seed_audit_log_created_at_idx').on(table.createdAt),
    index('recovery_seed_audit_log_agent_created_idx').on(
      table.agentId,
      table.createdAt,
    ),
  ]
);

export type RecoverySeedAuditLogRecord = typeof recoverySeedAuditLog.$inferSelect;
export type NewRecoverySeedAuditLogRecord = typeof recoverySeedAuditLog.$inferInsert;
export type RecoverySeedMethod = typeof recoverySeedMethodEnum.enumValues[number];
export type RecoverySeedEventKind = typeof recoverySeedEventKindEnum.enumValues[number];

/**
 * History of previously-active recovery public keys.
 *
 * When a user rotates their seed phrase (#14) the old public key is copied
 * here with a `retired_at` timestamp and a free-form `retirement_reason`.
 * Retention is lifetime-of-agent so federation peers can still verify
 * recovery events signed by the old key after the agent's active key has
 * changed.
 *
 * Plaintext seed material is never stored — only the public half.
 */
export const retiredRecoveryKeys = pgTable(
  'retired_recovery_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Public key (same encoding as `agents.recovery_public_key`). */
    publicKey: text('public_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    /** Timestamp at which the key was first created (copied from agents). */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    retiredAt: timestamp('retired_at', { withTimezone: true }).defaultNow().notNull(),
    /** rotated | revoked | compromised | ... (free-form). */
    retirementReason: text('retirement_reason').notNull().default('rotated'),
  },
  (table) => [
    index('retired_recovery_keys_agent_id_idx').on(table.agentId),
    index('retired_recovery_keys_fingerprint_idx').on(table.fingerprint),
  ]
);

export type RetiredRecoveryKeyRecord = typeof retiredRecoveryKeys.$inferSelect;
export type NewRetiredRecoveryKeyRecord = typeof retiredRecoveryKeys.$inferInsert;


// ---------------------------------------------------------------------------
// Federation-auth: accept-side credential temp-write (#16)
// ---------------------------------------------------------------------------

/**
 * Replay-protection ledger for incoming `credential.tempwrite.from-global`
 * events.  A nonce may appear at most once; the primary-key constraint is
 * the enforcement mechanism.
 *
 * Written by `src/lib/federation/accept-tempwrite.ts` inside the same
 * transaction that applies the credential update so a successful apply
 * and its nonce insert commit atomically.
 *
 * Rows are retained indefinitely: nonces are low-cardinality UUIDs and
 * bounded by rotation frequency, and indefinite retention is what makes
 * replay protection sound. Created by migration 0038.
 */
export const credentialTempwriteNonces = pgTable(
  'credential_tempwrite_nonces',
  {
    nonce: text('nonce').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    credentialVersion: integer('credential_version').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('credential_tempwrite_nonces_agent_id_idx').on(table.agentId),
    index('credential_tempwrite_nonces_seen_at_idx').on(table.seenAt),
  ]
);

export type CredentialTempwriteNonceRecord =
  typeof credentialTempwriteNonces.$inferSelect;
export type NewCredentialTempwriteNonceRecord =
  typeof credentialTempwriteNonces.$inferInsert;

/**
 * Append-only audit trail of credential-authority transitions.
 *
 * Every attempt to accept a global-signed credential temp-write produces
 * exactly one row — success or failure. Surfaces in the user activity
 * feed so owners can see when (and from where) credential material was
 * written by another authority.
 *
 * Future credential-authority events (e.g. `authority.revoke`,
 * `successor.authority.claim`) may reuse this table by setting
 * `eventKind` accordingly; the schema is intentionally generic.
 *
 * Created by migration 0038.
 */
export const credentialAuthorityAudit = pgTable(
  'credential_authority_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Discriminator — e.g. `tempwrite.accepted` or `tempwrite.rejected`. */
    eventKind: text('event_kind').notNull(),
    /** Issuer identifier — `global` for this ticket; peer slug in future. */
    source: text('source').notNull().default('global'),
    /** Short machine-readable outcome code: `accepted` or a rejection reason. */
    outcome: text('outcome').notNull(),
    /** Credential version from the event; null if rejected before parse. */
    credentialVersion: integer('credential_version'),
    /** Nonce from the event; null if rejected before parse. */
    nonce: text('nonce'),
    /** Best-effort client IP from forwarded headers. */
    ipAddress: text('ip_address'),
    /** Structured context: signingNodeSlug, rejectedField, previousVersion, etc. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('credential_authority_audit_agent_id_idx').on(table.agentId),
    index('credential_authority_audit_agent_created_idx').on(
      table.agentId,
      table.createdAt
    ),
    index('credential_authority_audit_event_kind_idx').on(table.eventKind),
  ]
);

export type CredentialAuthorityAuditRecord =
  typeof credentialAuthorityAudit.$inferSelect;
export type NewCredentialAuthorityAuditRecord =
  typeof credentialAuthorityAudit.$inferInsert;


// ---------------------------------------------------------------------------
// Recovery assertion nonces — home-side replay protection
// ---------------------------------------------------------------------------

/**
 * Single-use nonce record for global-issued recovery assertions consumed by
 * this home instance (migration 0041_recovery_assertion_nonces).
 *
 * Purpose:
 *   When a sovereign user forgets their home-instance password, global verifies
 *   their seed-phrase signature and issues a signed `recovery.assertion` with a
 *   nonce. The home endpoint `/api/recovery/accept-reset` must enforce
 *   single-use semantics — a replayed assertion MUST be rejected even if its
 *   signature is still valid.
 *
 * The unique index on `nonce` is the replay guarantee: a duplicate INSERT
 * raises a unique-violation which the route handler maps to a 409 Conflict.
 *
 * Related:
 *   - rivr-social/rivr-person#17 — API: /api/recovery/accept-reset.
 *   - HANDOFF 2026-04-19 "Recovery Plan" section 2.
 *   - src/lib/recovery/assertion.ts — verification + replay check.
 *   - src/app/api/recovery/accept-reset/route.ts — home acceptance endpoint.
 */
export const recoveryAssertionNonces = pgTable(
  'recovery_assertion_nonces',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Opaque, random string from the recovery assertion. Unique table-wide. */
    nonce: text('nonce').notNull(),
    /** Agent the assertion authorizes. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** Base URL of the global instance that issued the assertion. */
    issuerBaseUrl: text('issuer_base_url').notNull(),
    /** Intent string from the assertion (currently only `reset-password`). */
    intent: text('intent').notNull(),
    /** Server timestamp when the assertion was first successfully consumed. */
    consumedAt: timestamp('consumed_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Mirror of the assertion `exp` — used by the prune worker to remove stale rows. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('recovery_assertion_nonces_nonce_idx').on(table.nonce),
    index('recovery_assertion_nonces_agent_id_idx').on(table.agentId),
    index('recovery_assertion_nonces_expires_at_idx').on(table.expiresAt),
  ]
);

export type RecoveryAssertionNonceRecord =
  typeof recoveryAssertionNonces.$inferSelect;
export type NewRecoveryAssertionNonceRecord =
  typeof recoveryAssertionNonces.$inferInsert;

/**
 * link_previews cache table — backs POST /api/link-preview.
 *
 * One row per unique normalized URL (keyed by sha-256 of the URL). Fresh rows
 * are served directly; stale rows are refetched. Negative results (`error` /
 * `unsupported`) are cached to avoid hammering broken targets. See
 * `src/lib/link-preview.ts` for the TTL/freshness helpers and SSRF guard.
 */
export const linkPreviews = pgTable(
  'link_previews',
  {
    urlHash: text('url_hash').primaryKey(),
    url: text('url').notNull(),
    ogTitle: text('og_title'),
    ogDescription: text('og_description'),
    ogImage: text('og_image'),
    ogSiteName: text('og_site_name'),
    ogType: text('og_type'),
    favicon: text('favicon'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
    ttlSeconds: integer('ttl_seconds').default(86400).notNull(),
    fetchStatus: text('fetch_status').notNull(),
    fetchError: text('fetch_error'),
  },
  (table) => [
    index('link_previews_fetched_at_idx').on(table.fetchedAt),
    index('link_previews_fetch_status_idx').on(table.fetchStatus),
  ],
);

export type LinkPreviewRecord = typeof linkPreviews.$inferSelect;
export type NewLinkPreviewRecord = typeof linkPreviews.$inferInsert;
