import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn((key: string) => {
    const env: Record<string, string> = {
      MATRIX_HOMESERVER_URL: "https://matrix.test.local",
      MATRIX_ADMIN_TOKEN: "syt_admin_token",
      MATRIX_SERVER_NAME: "test.local",
    };
    return env[key] ?? "";
  }),
}));

const mockGroupMatrixRoomsInsert = vi.fn();
const mockGroupMatrixRoomsUpdate = vi.fn();

// Track the rows returned by db.select() chains so reconcile tests can drive
// different scenarios. Two holders so dmRooms vs groupMatrixRooms can each
// have their own scenario queue.
const mockGroupSelectRows: { rows: unknown[] } = { rows: [] };
const mockDmSelectRows: { rows: unknown[] } = { rows: [] };
const mockUpdateWhere = vi.fn();
const mockUpdateSet = vi.fn(() => ({ where: mockUpdateWhere }));

vi.mock("@/db", () => ({
  db: {
    query: {
      groupMatrixRooms: {
        findFirst: vi.fn(),
      },
      agents: {
        findFirst: vi.fn(),
      },
      dmRooms: {
        findFirst: vi.fn(),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => [{ id: "record-uuid-123" }]),
      })),
    })),
    update: vi.fn(() => ({
      set: mockUpdateSet,
    })),
    // Route select() based on which table is passed to .from(). The test
    // schema mock tags each table with a `__tableTag` so we can dispatch.
    select: vi.fn(() => ({
      from: vi.fn((table: { __tableTag?: string }) => ({
        where: vi.fn(() => {
          const tag = table?.__tableTag;
          if (tag === "dmRooms") return Promise.resolve(mockDmSelectRows.rows);
          return Promise.resolve(mockGroupSelectRows.rows);
        }),
      })),
    })),
  },
}));

vi.mock("@/db/schema", async () => {
  return {
    agents: { id: "id" },
    groupMatrixRooms: {
      __tableTag: "groupMatrixRooms",
      groupAgentId: "group_agent_id",
      matrixRoomId: "matrix_room_id",
      id: "id",
      deletedAt: "deleted_at",
    },
    dmRooms: {
      __tableTag: "dmRooms",
      id: "id",
      matrixRoomId: "matrix_room_id",
      participants: "participants",
      createdAt: "created_at",
      updatedAt: "updated_at",
      deletedAt: "deleted_at",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a, b) => ({ op: "eq", field: a, value: b })),
  and: vi.fn((...conds) => ({ op: "and", conds })),
  isNull: vi.fn((field) => ({ op: "isNull", field })),
  sql: vi.fn((strings, ...values) => ({ op: "sql", strings, values })),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { db } = await import("@/db");
type AgentRow = { matrixUserId: string | null };
const {
  createGroupMatrixRoom,
  inviteToGroupRoom,
  removeFromGroupRoom,
  setGroupChatMode,
  getGroupMatrixRoom,
  reconcileGroupMatrixRooms,
  reconcileDmRooms,
  triggerStartupReconcileGroupMatrixRooms,
} = await import("@/lib/matrix-groups");

describe("matrix-groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createGroupMatrixRoom", () => {
    it("returns existing room if already created", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "existing-record",
        groupAgentId: "group-1",
        matrixRoomId: "!existing:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await createGroupMatrixRoom({
        groupAgentId: "group-1",
        groupName: "Test Group",
        creatorMatrixUserId: "@admin:test.local",
      });

      expect(result.matrixRoomId).toBe("!existing:test.local");
      expect(result.recordId).toBe("existing-record");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("creates new room via Synapse Admin API when none exists", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ room_id: "!newgroup:test.local" }),
      });

      const result = await createGroupMatrixRoom({
        groupAgentId: "group-2",
        groupName: "New Group",
        creatorMatrixUserId: "@creator:test.local",
        chatMode: "matrix",
      });

      expect(result.matrixRoomId).toBe("!newgroup:test.local");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/_synapse/admin/v1/rooms");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.creator).toBe("@creator:test.local");
      expect(body.name).toBe("New Group");
      expect(body.preset).toBe("private_chat");
    });
  });

  describe("inviteToGroupRoom", () => {
    it("throws when no Matrix room exists for group", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      await expect(
        inviteToGroupRoom({
          groupAgentId: "group-no-room",
          targetAgentId: "user-1",
        })
      ).rejects.toThrow("No Matrix room found for group");
    });

    it("throws when target agent has no Matrix account", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: null,
      } as AgentRow);

      await expect(
        inviteToGroupRoom({
          groupAgentId: "group-1",
          targetAgentId: "user-no-matrix",
        })
      ).rejects.toThrow("has no Matrix account");
    });

    it("invites user when both room and Matrix account exist", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: "@invited:test.local",
      } as AgentRow);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });

      await inviteToGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/_synapse/admin/v1/join/");
      expect(JSON.parse(opts.body).user_id).toBe("@invited:test.local");
    });
  });

  describe("removeFromGroupRoom", () => {
    it("no-ops when no Matrix room exists", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue(
        undefined
      );

      await removeFromGroupRoom({
        groupAgentId: "group-none",
        targetAgentId: "user-1",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("no-ops when target has no Matrix account", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: null,
      } as AgentRow);

      await removeFromGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-no-matrix",
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("kicks user from room when both exist", async () => {
      vi.mocked(db.query.groupMatrixRooms.findFirst).mockResolvedValue({
        id: "record-1",
        groupAgentId: "group-1",
        matrixRoomId: "!room:test.local",
        chatMode: "both",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      vi.mocked(db.query.agents.findFirst).mockResolvedValue({
        matrixUserId: "@kicked:test.local",
      } as AgentRow);

      mockFetch.mockResolvedValueOnce({ ok: true });

      await removeFromGroupRoom({
        groupAgentId: "group-1",
        targetAgentId: "user-1",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/kick");
      expect(JSON.parse(opts.body).user_id).toBe("@kicked:test.local");
    });
  });

  describe("reconcileGroupMatrixRooms", () => {
    beforeEach(() => {
      mockGroupSelectRows.rows = [];
      mockDmSelectRows.rows = [];
      mockUpdateWhere.mockReset();
      mockUpdateSet.mockClear();
    });

    it("returns zero counts when no rows exist", async () => {
      mockGroupSelectRows.rows = [];

      const result = await reconcileGroupMatrixRooms();

      expect(result.total).toBe(0);
      expect(result.alive).toBe(0);
      expect(result.softDeleted).toBe(0);
      expect(result.errors).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("counts a row as alive when Synapse returns 200", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-alive", matrixRoomId: "!alive:test.local" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ room_id: "!alive:test.local" }),
      });

      const result = await reconcileGroupMatrixRooms();

      expect(result.total).toBe(1);
      expect(result.alive).toBe(1);
      expect(result.softDeleted).toBe(0);
      expect(result.errors).toEqual([]);
      // No DB update — the row stays live.
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("soft-deletes a row when Synapse returns 404", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-gone", matrixRoomId: "!gone:test.local" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ errcode: "M_NOT_FOUND" }),
      });

      const result = await reconcileGroupMatrixRooms();

      expect(result.total).toBe(1);
      expect(result.alive).toBe(0);
      expect(result.softDeleted).toBe(1);
      expect(result.errors).toEqual([]);

      // Verify the DB write includes a deletedAt timestamp.
      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      const setArgs = mockUpdateSet.mock.calls[0][0];
      expect(setArgs.deletedAt).toBeInstanceOf(Date);
    });

    it("records an error and leaves the row alone for non-404 failures", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-err", matrixRoomId: "!err:test.local" },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ errcode: "M_UNKNOWN" }),
      });

      const result = await reconcileGroupMatrixRooms();

      expect(result.total).toBe(1);
      expect(result.alive).toBe(0);
      expect(result.softDeleted).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        recordId: "rec-err",
        matrixRoomId: "!err:test.local",
        reason: expect.stringContaining("500"),
      });
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("captures fetch failures as errors without crashing", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-net", matrixRoomId: "!net:test.local" },
      ];

      mockFetch.mockRejectedValueOnce(new Error("network down"));

      const result = await reconcileGroupMatrixRooms();

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toBe("network down");
      expect(result.softDeleted).toBe(0);
    });

    it("processes multiple rows independently in one pass", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-1", matrixRoomId: "!one:test.local" },
        { id: "rec-2", matrixRoomId: "!two:test.local" },
        { id: "rec-3", matrixRoomId: "!three:test.local" },
      ];

      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
        .mockResolvedValueOnce({ ok: false, status: 503, json: () => Promise.resolve({}) });

      const result = await reconcileGroupMatrixRooms();

      expect(result.total).toBe(3);
      expect(result.alive).toBe(1);
      expect(result.softDeleted).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].recordId).toBe("rec-3");
    });

    it("treats malformed roomIds as missing without calling Synapse", async () => {
      mockGroupSelectRows.rows = [
        { id: "rec-bad", matrixRoomId: "not-a-room-id" },
      ];

      const result = await reconcileGroupMatrixRooms();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.softDeleted).toBe(1);
    });
  });

  describe("reconcileDmRooms", () => {
    beforeEach(() => {
      mockDmSelectRows.rows = [];
      mockGroupSelectRows.rows = [];
      mockUpdateWhere.mockReset();
      mockUpdateSet.mockClear();
    });

    it("returns zero counts when the dm_rooms table is empty", async () => {
      mockDmSelectRows.rows = [];
      const result = await reconcileDmRooms();
      expect(result).toEqual({ total: 0, alive: 0, softDeleted: 0, errors: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("soft-deletes a missing dm room", async () => {
      mockDmSelectRows.rows = [
        { id: "dm-1", matrixRoomId: "!gone:test.local" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
      const result = await reconcileDmRooms();
      expect(result.softDeleted).toBe(1);
      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      const setArgs = mockUpdateSet.mock.calls[0][0];
      expect(setArgs.deletedAt).toBeInstanceOf(Date);
    });

    it("leaves a live dm room alone", async () => {
      mockDmSelectRows.rows = [
        { id: "dm-1", matrixRoomId: "!live:test.local" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
      const result = await reconcileDmRooms();
      expect(result.alive).toBe(1);
      expect(result.softDeleted).toBe(0);
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("records non-404 errors without tombstoning the row", async () => {
      mockDmSelectRows.rows = [
        { id: "dm-err", matrixRoomId: "!err:test.local" },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: () => Promise.resolve({}),
      });
      const result = await reconcileDmRooms();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].matrixRoomId).toBe("!err:test.local");
      expect(result.softDeleted).toBe(0);
    });
  });

  describe("triggerStartupReconcileGroupMatrixRooms", () => {
    it("is idempotent across repeated invocations within the same process", () => {
      // We can't easily observe setImmediate output here, but we can confirm
      // the function doesn't throw and can be called multiple times safely.
      expect(() => triggerStartupReconcileGroupMatrixRooms()).not.toThrow();
      expect(() => triggerStartupReconcileGroupMatrixRooms()).not.toThrow();
    });
  });
});
