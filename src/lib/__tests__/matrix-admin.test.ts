import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn((key: string) => {
    const env: Record<string, string> = {
      MATRIX_HOMESERVER_URL: "https://matrix.test.local",
      MATRIX_ADMIN_TOKEN: "syt_admin_token_123",
      MATRIX_SERVER_NAME: "test.local",
    };
    return env[key] ?? "";
  }),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamic import after mocks are set up
const {
  provisionMatrixUser,
  deactivateMatrixUser,
  updateMatrixProfile,
  createDirectMessageRoom,
} = await import("@/lib/matrix-admin");
const { MatrixProvisioningError } = await import("@/lib/matrix-errors");

describe("matrix-admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("provisionMatrixUser", () => {
    it("creates a Matrix user and returns credentials", async () => {
      // First call: PUT user registration
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      // Second call: POST login to get access token
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "syt_user_access_token" }),
      });

      const result = await provisionMatrixUser({
        localpart: "abc123",
        displayName: "Test User",
      });

      expect(result.matrixUserId).toBe("@abc123:test.local");
      expect(result.accessToken).toBe("syt_user_access_token");

      // Verify registration call
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [regUrl, regOpts] = mockFetch.mock.calls[0];
      expect(regUrl).toContain(
        "/_synapse/admin/v2/users/%40abc123%3Atest.local"
      );
      expect(regOpts.method).toBe("PUT");
      expect(JSON.parse(regOpts.body)).toEqual({
        displayname: "Test User",
        admin: false,
        deactivated: false,
      });

      // Verify login call
      const [loginUrl, loginOpts] = mockFetch.mock.calls[1];
      expect(loginUrl).toContain(
        "/_synapse/admin/v1/users/%40abc123%3Atest.local/login"
      );
      expect(loginOpts.method).toBe("POST");
    });

    it("throws MatrixProvisioningError with stage=user_create on PUT failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errcode: "M_UNKNOWN" }),
      });

      let caught: unknown = null;
      try {
        await provisionMatrixUser({
          localpart: "fail_user",
          displayName: "Fail",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MatrixProvisioningError);
      expect((caught as InstanceType<typeof MatrixProvisioningError>).stage).toBe(
        "user_create",
      );
    });

    it("throws MatrixProvisioningError with stage=user_login when /login fails after PUT succeeds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ errcode: "M_LIMIT_EXCEEDED" }),
      });

      let caught: unknown = null;
      try {
        await provisionMatrixUser({
          localpart: "login_fail",
          displayName: "LoginFail",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MatrixProvisioningError);
      expect((caught as InstanceType<typeof MatrixProvisioningError>).stage).toBe(
        "user_login",
      );
    });

    it("throws MatrixProvisioningError with stage=missing_token when Synapse returns no access_token", async () => {
      // PUT user succeeds
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // Login returns 200 but with no access_token in the body
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: "" }),
      });

      let caught: unknown = null;
      try {
        await provisionMatrixUser({
          localpart: "empty_token",
          displayName: "EmptyToken",
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(MatrixProvisioningError);
      expect((caught as InstanceType<typeof MatrixProvisioningError>).stage).toBe(
        "missing_token",
      );
    });

    it("supports re-provisioning when Synapse user already exists (PUT idempotent)", async () => {
      // First PUT — Synapse returns 200 (existing user updated)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
      // Login issues a fresh token even though the user already existed
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ access_token: "syt_reissued_token_456" }),
      });

      const result = await provisionMatrixUser({
        localpart: "existing_user",
        displayName: "Existing User",
      });

      expect(result.matrixUserId).toBe("@existing_user:test.local");
      expect(result.accessToken).toBe("syt_reissued_token_456");
    });
  });

  describe("deactivateMatrixUser", () => {
    it("sends deactivation request to Synapse", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await deactivateMatrixUser("@olduser:test.local");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain(
        "/_synapse/admin/v2/users/%40olduser%3Atest.local"
      );
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual({ deactivated: true });
    });
  });

  describe("updateMatrixProfile", () => {
    it("updates display name via Synapse admin API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await updateMatrixProfile({
        matrixUserId: "@user:test.local",
        displayName: "New Name",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({ displayname: "New Name" });
    });

    it("updates both name and avatar when both provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await updateMatrixProfile({
        matrixUserId: "@user:test.local",
        displayName: "Updated",
        avatarUrl: "mxc://test.local/avatar123",
      });

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({
        displayname: "Updated",
        avatar_url: "mxc://test.local/avatar123",
      });
    });

    it("does not call API when no updates provided", async () => {
      await updateMatrixProfile({ matrixUserId: "@user:test.local" });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("createDirectMessageRoom", () => {
    it("creates a DM room and returns room ID", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ room_id: "!newroom:test.local" }),
      });

      const result = await createDirectMessageRoom({
        inviterUserId: "@alice:test.local",
        inviteeUserId: "@bob:test.local",
      });

      expect(result.roomId).toBe("!newroom:test.local");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/_synapse/admin/v1/rooms");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({
        creator: "@alice:test.local",
        invite: ["@bob:test.local"],
        is_direct: true,
        preset: "trusted_private_chat",
      });
    });
  });
});
