/**
 * Unit tests for the link-preview helpers.
 *
 * Covers: URL extraction, normalization, hashing, TTL clamping, shape
 * validation, private IPv4/IPv6 detection, SSRF DNS guard, internal-URL
 * detection, and cache freshness.
 *
 * These tests are pure — no DB, no network. `assertSafeHost` DNS calls
 * are stubbed via vitest's module mock of `node:dns/promises`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dns BEFORE importing the module under test so the stubbed lookup is
// in place when the module caches the reference.
const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  clampTtl,
  extractUrls,
  hashUrl,
  isCacheFresh,
  isInternalSubspaceUrl,
  isPrivateIPv4,
  isPrivateIPv6,
  normalizeUrl,
  parseInternalSubspaceUrl,
  validateUrlShape,
  assertSafeHost,
  LINK_PREVIEW_DEFAULT_TTL_SECONDS,
  LINK_PREVIEW_MIN_TTL_SECONDS,
  LINK_PREVIEW_MAX_TTL_SECONDS,
  URL_REJECTION_REASON,
} from '../link-preview';

describe('extractUrls', () => {
  it('returns an empty array for empty input', () => {
    expect(extractUrls('')).toEqual([]);
    expect(extractUrls('no urls here')).toEqual([]);
  });

  it('extracts a single http url', () => {
    expect(extractUrls('Check out http://example.com for info')).toEqual([
      'http://example.com',
    ]);
  });

  it('extracts multiple unique urls preserving first-seen order', () => {
    const out = extractUrls('first https://a.com then https://b.com and https://a.com again');
    expect(out).toEqual(['https://a.com', 'https://b.com']);
  });

  it('strips common trailing punctuation when extracting from prose', () => {
    expect(extractUrls('See https://example.com.')).toEqual(['https://example.com']);
    expect(extractUrls('(https://example.com)')).toEqual(['https://example.com']);
    expect(extractUrls('"https://example.com",')).toEqual(['https://example.com']);
  });

  it('handles urls adjacent to newlines and tabs', () => {
    expect(extractUrls('https://a.com\nhttps://b.com\thttps://c.com'))
      .toEqual(['https://a.com', 'https://b.com', 'https://c.com']);
  });
});

describe('normalizeUrl', () => {
  it('lowercases host, drops fragments, sorts query params', () => {
    const n = normalizeUrl('https://Example.COM/path?b=2&a=1#frag');
    expect(n).toBe('https://example.com/path?a=1&b=2');
  });

  it('returns null for unparseable input', () => {
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('hashUrl', () => {
  it('produces a stable 64-char hex hash', () => {
    const h = hashUrl('https://example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('yields the same hash for URLs that normalize identically', () => {
    expect(hashUrl('https://Example.com/a?b=2&a=1#x'))
      .toBe(hashUrl('https://example.com/a?a=1&b=2'));
  });

  it('returns null for invalid input', () => {
    expect(hashUrl('garbage')).toBeNull();
  });
});

describe('clampTtl', () => {
  it('returns the default when input is missing or invalid', () => {
    expect(clampTtl(undefined)).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
    expect(clampTtl(null)).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
    expect(clampTtl('not a number')).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
    expect(clampTtl(NaN)).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
    expect(clampTtl(0)).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
    expect(clampTtl(-5)).toBe(LINK_PREVIEW_DEFAULT_TTL_SECONDS);
  });

  it('clamps to [MIN, MAX]', () => {
    expect(clampTtl(1)).toBe(LINK_PREVIEW_MIN_TTL_SECONDS);
    expect(clampTtl(10_000_000)).toBe(LINK_PREVIEW_MAX_TTL_SECONDS);
  });

  it('passes through a valid ttl, flooring fractions', () => {
    expect(clampTtl(3600.9)).toBe(3600);
  });
});

describe('validateUrlShape', () => {
  it('accepts http and https', () => {
    expect(validateUrlShape('http://example.com').ok).toBe(true);
    expect(validateUrlShape('https://example.com').ok).toBe(true);
  });

  it('rejects unparseable strings', () => {
    const res = validateUrlShape('oopsie');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(URL_REJECTION_REASON.UNPARSEABLE);
  });

  it('rejects non http(s) protocols', () => {
    const r1 = validateUrlShape('ftp://example.com');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe(URL_REJECTION_REASON.BAD_PROTOCOL);
    const r2 = validateUrlShape('javascript:alert(1)');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe(URL_REJECTION_REASON.BAD_PROTOCOL);
  });

  it('rejects localhost-style hostnames', () => {
    const res = validateUrlShape('http://localhost/');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe(URL_REJECTION_REASON.BLOCKED_HOST);
  });
});

describe('isPrivateIPv4', () => {
  it('flags each private range', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.1.2.3')).toBe(true);
    expect(isPrivateIPv4('192.168.1.1')).toBe(true);
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.254')).toBe(true);
    expect(isPrivateIPv4('169.254.1.1')).toBe(true); // link-local
    expect(isPrivateIPv4('100.64.0.1')).toBe(true); // cgnat
    expect(isPrivateIPv4('0.0.0.0')).toBe(true);
    expect(isPrivateIPv4('224.0.0.1')).toBe(true); // multicast
    expect(isPrivateIPv4('240.0.0.1')).toBe(true); // reserved
  });

  it('lets public addresses through', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('172.15.0.1')).toBe(false); // just outside 172.16/12
    expect(isPrivateIPv4('172.32.0.1')).toBe(false); // just outside
    expect(isPrivateIPv4('100.63.255.255')).toBe(false); // just outside cgnat
  });

  it('rejects malformed ipv4 strings', () => {
    expect(isPrivateIPv4('256.1.1.1')).toBe(false);
    expect(isPrivateIPv4('1.2.3')).toBe(false);
    expect(isPrivateIPv4('abc')).toBe(false);
  });
});

describe('isPrivateIPv6', () => {
  it('flags loopback, link-local, unique-local, multicast', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('fe80::1')).toBe(true);
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });

  it('treats ipv4-mapped addresses by their embedded v4', () => {
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
  });

  it('lets public v6 through', () => {
    expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertSafeHost', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('resolves cleanly for public addresses', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    await expect(assertSafeHost('dns.google')).resolves.toBeUndefined();
  });

  it('rejects when any resolved address is private', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertSafeHost('mixed.example.com')).rejects.toThrow('private_host');
  });

  it('rejects when a private v6 is returned', async () => {
    lookupMock.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    await expect(assertSafeHost('loopback.example')).rejects.toThrow('private_host');
  });

  it('rejects empty dns results', async () => {
    lookupMock.mockResolvedValueOnce([]);
    await expect(assertSafeHost('nothing.example')).rejects.toThrow('private_host');
  });
});

describe('isInternalSubspaceUrl / parseInternalSubspaceUrl', () => {
  it('treats matching paths on self-host as internal', () => {
    expect(isInternalSubspaceUrl('https://a.rivr.social/rings/abc', 'a.rivr.social')).toBe(true);
    expect(isInternalSubspaceUrl('https://a.rivr.social/groups/xyz', 'a.rivr.social')).toBe(true);
    expect(isInternalSubspaceUrl('https://a.rivr.social/profile/cameron', 'a.rivr.social')).toBe(true);
  });

  it('rejects different hosts when self-host supplied', () => {
    expect(isInternalSubspaceUrl('https://other.example.com/rings/x', 'a.rivr.social')).toBe(false);
  });

  it('accepts known path prefixes without a self-host check', () => {
    expect(isInternalSubspaceUrl('https://any.example.com/groups/1')).toBe(true);
  });

  it('ignores unknown first segments', () => {
    expect(isInternalSubspaceUrl('https://a.rivr.social/about', 'a.rivr.social')).toBe(false);
  });

  it('parses the (kind, id) pair', () => {
    expect(parseInternalSubspaceUrl('https://a.rivr.social/rings/abc123'))
      .toEqual({ kind: 'rings', id: 'abc123' });
    expect(parseInternalSubspaceUrl('https://a.rivr.social/profile/cameron'))
      .toEqual({ kind: 'profile', id: 'cameron' });
  });

  it('returns null for unrecognised paths', () => {
    expect(parseInternalSubspaceUrl('https://a.rivr.social/about')).toBeNull();
    expect(parseInternalSubspaceUrl('https://a.rivr.social/rings')).toBeNull();
  });
});

describe('isCacheFresh', () => {
  it('returns true while within ttl', () => {
    const now = Date.parse('2026-04-19T00:00:00Z');
    const fetchedAt = new Date(now - 1000);
    expect(isCacheFresh(fetchedAt, 60, now)).toBe(true);
  });

  it('returns false after ttl elapses', () => {
    const now = Date.parse('2026-04-19T00:00:00Z');
    const fetchedAt = new Date(now - 61_000);
    expect(isCacheFresh(fetchedAt, 60, now)).toBe(false);
  });

  it('accepts ISO strings as well as Date', () => {
    const now = Date.parse('2026-04-19T00:00:00Z');
    const fetchedAt = new Date(now - 10_000).toISOString();
    expect(isCacheFresh(fetchedAt, 60, now)).toBe(true);
  });
});
