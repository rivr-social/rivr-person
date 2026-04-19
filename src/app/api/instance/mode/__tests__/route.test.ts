/**
 * Tests for the `/api/instance/mode` route.
 *
 * The route is a thin wrapper around `getInstanceMode()` in
 * `@/lib/instance-mode`. Here we verify HTTP semantics:
 * - 200 + well-formed body for both valid modes
 * - 200 default body when the env var is unset
 * - 500 + structured error body when the env var is invalid
 * - No authentication is required (public discovery).
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { STATUS_OK, STATUS_INTERNAL_ERROR } from '@/lib/http-status';
import {
  INSTANCE_MODE_ENV_VAR,
  INSTANCE_MODE_HOSTED_FEDERATED,
  INSTANCE_MODE_SOVEREIGN,
  resetInstanceModeCache,
} from '@/lib/instance-mode';
import { GET } from '../route';

const REQUEST_URL = 'http://localhost:3000/api/instance/mode';
const originalEnv = process.env;

function buildRequest(): Request {
  return new Request(REQUEST_URL, { method: 'GET' });
}

describe('GET /api/instance/mode', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env[INSTANCE_MODE_ENV_VAR];
    resetInstanceModeCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetInstanceModeCache();
  });

  it('returns sovereign by default when env var is unset', async () => {
    const response = await GET(buildRequest());
    expect(response.status).toBe(STATUS_OK);

    const body = await response.json();
    expect(body).toEqual({ mode: INSTANCE_MODE_SOVEREIGN });
  });

  it('returns sovereign when explicitly configured', async () => {
    process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_SOVEREIGN;
    const response = await GET(buildRequest());
    expect(response.status).toBe(STATUS_OK);

    const body = await response.json();
    expect(body).toEqual({ mode: INSTANCE_MODE_SOVEREIGN });
  });

  it('returns hosted-federated when explicitly configured', async () => {
    process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_HOSTED_FEDERATED;
    const response = await GET(buildRequest());
    expect(response.status).toBe(STATUS_OK);

    const body = await response.json();
    expect(body).toEqual({ mode: INSTANCE_MODE_HOSTED_FEDERATED });
  });

  it('returns 500 with structured error when env var is invalid', async () => {
    process.env[INSTANCE_MODE_ENV_VAR] = 'federated-platypus';
    const response = await GET(buildRequest());
    expect(response.status).toBe(STATUS_INTERNAL_ERROR);

    const body = await response.json();
    expect(body).toMatchObject({
      error: 'invalid_instance_mode',
    });
    expect(body.message).toContain('federated-platypus');
    expect(body.message).toContain('sovereign');
    expect(body.message).toContain('hosted-federated');
  });

  it('returns a JSON content-type header', async () => {
    const response = await GET(buildRequest());
    expect(response.headers.get('content-type')).toMatch(/application\/json/);
  });
});
