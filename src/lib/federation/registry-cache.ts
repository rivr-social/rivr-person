// src/lib/federation/registry-cache.ts

/**
 * In-memory cache for federation instance registry lookups.
 *
 * Prevents repeated network/DB calls when resolving the same instance
 * during a single request lifecycle or across short-lived client operations.
 * Uses a TTL-based eviction strategy with configurable defaults.
 */

import type { HomeInstanceInfo } from "./resolution";

/** Default TTL for cached entries: 5 minutes */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Maximum number of entries before the oldest are evicted */
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface RegistryCacheOptions {
  /** Time-to-live in milliseconds for cached entries */
  ttlMs?: number;
  /** Maximum number of entries before LRU eviction kicks in */
  maxEntries?: number;
}

/**
 * Generic TTL cache used by the federation registry layer.
 *
 * Entries expire after `ttlMs` and the cache evicts the oldest entries
 * when `maxEntries` is exceeded. Thread-safe for single-threaded JS
 * runtimes (Node / browser main thread).
 */
class TTLCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: RegistryCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Move to end for LRU ordering (Map preserves insertion order)
    this.store.delete(key);
    this.store.set(key, entry);

    return entry.value;
  }

  set(key: string, value: T): void {
    // Remove first so re-insertion updates position
    this.store.delete(key);

    // Evict oldest entries if at capacity
    while (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      } else {
        break;
      }
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

// ─── Singleton Caches ─────────────────────────────────────────────────────────

/** Cache for agent-to-home-instance resolution */
const instanceByAgentCache = new TTLCache<HomeInstanceInfo>({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: MAX_CACHE_ENTRIES,
});

/** Cache for instance listings (keyed by a sentinel string) */
const instanceListCache = new TTLCache<HomeInstanceInfo[]>({
  ttlMs: DEFAULT_TTL_MS,
  maxEntries: 1,
});

const INSTANCE_LIST_KEY = "__all_instances__";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Retrieve a cached home instance resolution for a given agent ID.
 * Returns `undefined` on cache miss or expiry.
 */
export function getCachedInstance(agentId: string): HomeInstanceInfo | undefined {
  return instanceByAgentCache.get(agentId);
}

/**
 * Store a home instance resolution result in the cache.
 */
export function setCachedInstance(agentId: string, info: HomeInstanceInfo): void {
  instanceByAgentCache.set(agentId, info);
}

/**
 * Retrieve the cached list of all known instances.
 * Returns `undefined` on cache miss or expiry.
 */
export function getCachedInstanceList(): HomeInstanceInfo[] | undefined {
  return instanceListCache.get(INSTANCE_LIST_KEY);
}

/**
 * Store the full instance list in the cache.
 */
export function setCachedInstanceList(instances: HomeInstanceInfo[]): void {
  instanceListCache.set(INSTANCE_LIST_KEY, instances);
}

/**
 * Look up a specific instance by node ID from the cached instance list.
 * Falls back to `undefined` if the list is not cached or the node is not found.
 */
export function getCachedInstanceByNodeId(nodeId: string): HomeInstanceInfo | undefined {
  const list = getCachedInstanceList();
  if (!list) return undefined;
  return list.find((inst) => inst.nodeId === nodeId);
}

/**
 * Invalidate a single agent's cached instance resolution.
 */
export function invalidateCachedInstance(agentId: string): void {
  instanceByAgentCache.delete(agentId);
}

/**
 * Invalidate the cached instance list.
 */
export function invalidateCachedInstanceList(): void {
  instanceListCache.delete(INSTANCE_LIST_KEY);
}

/**
 * Clear all federation registry caches.
 * Useful for testing or when the federation topology changes.
 */
export function clearRegistryCache(): void {
  instanceByAgentCache.clear();
  instanceListCache.clear();
}

/**
 * Return current cache statistics for observability.
 */
export function getRegistryCacheStats(): {
  agentCacheSize: number;
  instanceListCached: boolean;
} {
  return {
    agentCacheSize: instanceByAgentCache.size,
    instanceListCached: instanceListCache.has(INSTANCE_LIST_KEY),
  };
}

// Re-export the TTLCache class for cases where consumers need a custom cache
export { TTLCache };
export type { RegistryCacheOptions };
