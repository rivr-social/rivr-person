/**
 * Unit tests for POST /api/link-preview.
 *
 * Covers the main request-lifecycle branches:
 *   - unauthenticated → 401
 *   - rate-limited    → 429
 *   - invalid JSON / missing url / bad protocol → 400
 *   - SSRF-blocked (private DNS) → 400 + negative cache row
 *   - internal subspace URL short-circuit (no outbound fetch)
 *   - cache hit
 *   - cache miss → successful outbound fetch → upsert → returned payload
 *
 * DB, auth, rate-limit, and open-graph-scraper are mocked. Nothing in these
 * tests ever hits the network or a real database.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared inside factories so the hoisted vi.mock calls can resolve
// without reaching for top-level const bindings. Handles to the mock fns are
// pulled out via dynamic imports at the top of the test body.
// ---------------------------------------------------------------------------
vi.mock('@/auth', () => {
  const authFn = vi.fn();
  return { auth: authFn, __authFn: authFn };
});

vi.mock('@/lib/rate-limit', () => {
  const rateLimitFn = vi.fn();
  return {
    rateLimit: rateLimitFn,
    RATE_LIMITS: { SOCIAL: { limit: 60, windowMs: 60_000 } },
    __rateLimitFn: rateLimitFn,
  };
});

vi.mock('@/db', () => {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(),
  };
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  const db = {
    select: vi.fn(() => selectChain),
    insert: vi.fn(() => insertChain),
  };
  return { db, __db: db, __selectChain: selectChain, __insertChain: insertChain };
});

vi.mock('node:dns/promises', () => {
  const lookupFn = vi.fn();
  return { lookup: lookupFn, __lookupFn: lookupFn };
});

vi.mock('open-graph-scraper', () => {
  const ogsFn = vi.fn();
  return { default: ogsFn, __ogsFn: ogsFn };
});

import { POST } from '../route';

// Retrieve mock handles through the module side-channel. Because the mocks
// are factories, these imports return the same module instances that the
// route under test picks up.
const authModule = (await import('@/auth')) as unknown as { __authFn: ReturnType<typeof vi.fn> };
const rateLimitModule = (await import('@/lib/rate-limit')) as unknown as { __rateLimitFn: ReturnType<typeof vi.fn> };
const dbModule = (await import('@/db')) as unknown as {
  __db: { select: ReturnType<typeof vi.fn>; insert: ReturnType<typeof vi.fn> };
  __selectChain: { from: ReturnType<typeof vi.fn>; where: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> };
  __insertChain: {
    values: ReturnType<typeof vi.fn>;
    onConflictDoUpdate: ReturnType<typeof vi.fn>;
    returning: ReturnType<typeof vi.fn>;
  };
};
const dnsModule = (await import('node:dns/promises')) as unknown as { __lookupFn: ReturnType<typeof vi.fn> };
const ogsModule = (await import('open-graph-scraper')) as unknown as { __ogsFn: ReturnType<typeof vi.fn> };

const mockAuth = authModule.__authFn;
const mockRateLimit = rateLimitModule.__rateLimitFn;
const mockDb = dbModule.__db;
const selectChain = dbModule.__selectChain;
const insertChain = dbModule.__insertChain;
const mockLookup = dnsModule.__lookupFn;
const mockOgs = ogsModule.__ogsFn;

function makeRequest(body: unknown, host = 'a.rivr.social'): NextRequest {
  return new NextRequest('http://localhost:3000/api/link-preview', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host,
      'x-real-ip': '203.0.113.7',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** Convenience: install the default "authenticated + under limit" setup. */
function authenticate() {
  mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
  mockRateLimit.mockResolvedValue({ success: true, remaining: 59, resetMs: 1000 });
}

describe('POST /api/link-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no cache row, insert returns a minimal row echo.
    selectChain.limit.mockResolvedValue([]);
    insertChain.returning.mockResolvedValue([
      {
        urlHash: 'hash',
        url: 'https://example.com/',
        ogTitle: null,
        ogDescription: null,
        ogImage: null,
        ogSiteName: null,
        ogType: null,
        favicon: null,
        fetchedAt: new Date('2026-04-19T00:00:00Z'),
        ttlSeconds: 86_400,
        fetchStatus: 'ok',
        fetchError: null,
      },
    ]);
  });

  it('returns 401 when the caller is not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('returns 429 when rate-limited', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    mockRateLimit.mockResolvedValue({ success: false, remaining: 0, resetMs: 60_000 });
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
  });

  it('returns 400 for invalid JSON', async () => {
    authenticate();
    const res = await POST(makeRequest('not json'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_json');
  });

  it('returns 400 when url is missing', async () => {
    authenticate();
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('missing_url');
  });

  it('rejects non-http(s) protocols with detail=bad_protocol', async () => {
    authenticate();
    const res = await POST(makeRequest({ url: 'javascript:alert(1)' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_url');
    expect(body.detail).toBe('bad_protocol');
  });

  it('rejects localhost immediately without DNS', async () => {
    authenticate();
    const res = await POST(makeRequest({ url: 'http://localhost/' }));
    expect(res.status).toBe(400);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockOgs).not.toHaveBeenCalled();
  });

  it('short-circuits internal subspace urls — no OG fetch, no cache lookup', async () => {
    authenticate();
    // Internal resolver queries agents or resources; return nothing so the
    // route falls back to the minimal internal embed.
    selectChain.limit.mockResolvedValue([]);
    const res = await POST(
      makeRequest({ url: 'https://a.rivr.social/rings/ring-123' }, 'a.rivr.social'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview.kind).toBe('internal');
    expect(body.cached).toBe(false);
    expect(mockOgs).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    // We do NOT persist internal previews to the link_previews cache.
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('returns cached preview when the row is fresh', async () => {
    authenticate();
    selectChain.limit.mockResolvedValue([
      {
        urlHash: 'hash',
        url: 'https://example.com/',
        ogTitle: 'Cached Title',
        ogDescription: 'Cached Description',
        ogImage: 'https://cdn.example.com/og.png',
        ogSiteName: 'Example',
        ogType: 'website',
        favicon: null,
        fetchedAt: new Date(Date.now() - 1000),
        ttlSeconds: 3600,
        fetchStatus: 'ok',
        fetchError: null,
      },
    ]);
    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cached).toBe(true);
    expect(body.preview.ogTitle).toBe('Cached Title');
    // No outbound fetch or DNS should have occurred on a cache hit.
    expect(mockOgs).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('rejects SSRF hosts (private DNS) with 400 and writes a negative cache row', async () => {
    authenticate();
    selectChain.limit.mockResolvedValue([]);
    mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);

    const res = await POST(makeRequest({ url: 'https://internal.test/' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.detail).toBe('blocked_host');
    // Negative cache: we insert a row with fetch_status='unsupported'.
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
    const values = insertChain.values.mock.calls[0][0];
    expect(values.fetchStatus).toBe('unsupported');
    expect(values.fetchError).toBe('ssrf_blocked');
    // We did NOT attempt an outbound OG fetch.
    expect(mockOgs).not.toHaveBeenCalled();
  });

  it('performs a cache miss → OG fetch → upsert on a healthy public URL', async () => {
    authenticate();
    selectChain.limit.mockResolvedValue([]);
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockOgs.mockResolvedValue({
      error: false,
      result: {
        ogTitle: 'Example Title',
        ogDescription: 'Example Description',
        ogSiteName: 'Example',
        ogType: 'website',
        ogImage: [{ url: 'https://example.com/og.png' }],
        favicon: '/favicon.ico',
      },
    });
    insertChain.returning.mockResolvedValue([
      {
        urlHash: 'hash',
        url: 'https://example.com/',
        ogTitle: 'Example Title',
        ogDescription: 'Example Description',
        ogImage: 'https://example.com/og.png',
        ogSiteName: 'Example',
        ogType: 'website',
        favicon: 'https://example.com/favicon.ico',
        fetchedAt: new Date('2026-04-19T00:00:00Z'),
        ttlSeconds: 86_400,
        fetchStatus: 'ok',
        fetchError: null,
      },
    ]);

    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.preview.ogTitle).toBe('Example Title');
    expect(body.preview.ogImage).toBe('https://example.com/og.png');
    expect(body.preview.favicon).toBe('https://example.com/favicon.ico');
    expect(mockOgs).toHaveBeenCalledTimes(1);
    expect(mockDb.insert).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 with fetchStatus=error when the OG fetch fails (negative cache)', async () => {
    authenticate();
    selectChain.limit.mockResolvedValue([]);
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockOgs.mockRejectedValue(new Error('timeout'));
    insertChain.returning.mockResolvedValue([
      {
        urlHash: 'hash',
        url: 'https://example.com/',
        ogTitle: null,
        ogDescription: null,
        ogImage: null,
        ogSiteName: null,
        ogType: null,
        favicon: null,
        fetchedAt: new Date('2026-04-19T00:00:00Z'),
        ttlSeconds: 86_400,
        fetchStatus: 'error',
        fetchError: 'timeout',
      },
    ]);

    const res = await POST(makeRequest({ url: 'https://example.com' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.preview.fetchStatus).toBe('error');
  });
});
