import { describe, it, expect, beforeEach, vi } from "vitest";

// =============================================================================
// Mock matrix-js-sdk
// =============================================================================

const mockClient = {
  getUserId: vi.fn(() => "@user1:test.local"),
  stopClient: vi.fn(),
  startClient: vi.fn(),
  once: vi.fn((_event: string, cb: (state: string) => void) => {
    // Immediately resolve sync
    cb("PREPARED");
  }),
  on: vi.fn(),
  removeListener: vi.fn(),
  getRooms: vi.fn(() => []),
  getRoom: vi.fn(),
  getAccountData: vi.fn(),
  setAccountData: vi.fn(),
  sendMessage: vi.fn(() => Promise.resolve({ event_id: "$evt1" })),
  createRoom: vi.fn(() => Promise.resolve({ room_id: "!newroom:test.local" })),
  sendReadReceipt: vi.fn(),
};

vi.mock("matrix-js-sdk", () => ({
  createClient: vi.fn(() => mockClient),
  MsgType: { Text: "m.text" },
  Preset: { TrustedPrivateChat: "trusted_private_chat" },
  ClientEvent: { Sync: "sync" },
  EventType: { Direct: "m.direct" },
  RoomEvent: { Timeline: "Room.timeline" },
}));

vi.mock("@/app/actions/matrix", () => ({
  ensureUserJoinedRoom: vi.fn(() => Promise.resolve()),
}));

const {
  getMatrixClient,
  startSync,
  stopSync,
  sendMessage,
  getOrCreateDmRoom,
  getDmRooms,
  persistMDirectWithRetry,
  MatrixDirectRepairError,
} = await import("@/lib/matrix-client");

const {
  onMatrixSyncRepair,
  clearMatrixSyncRepairListenersForTesting,
  MATRIX_SYNC_REPAIR_FAILED,
  MATRIX_SYNC_REPAIR_SUCCEEDED,
  MATRIX_SYNC_REPAIR_EXHAUSTED,
} = await import("@/lib/matrix-sync-events");

describe("matrix-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset module singleton by stopping any existing client
    stopSync();
  });

  describe("getMatrixClient", () => {
    it("creates a new MatrixClient on first call", () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      expect(client).toBeDefined();
      expect(client.getUserId()).toBe("@user1:test.local");
    });

    it("returns cached client for same userId", () => {
      const client1 = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const client2 = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      expect(client1).toBe(client2);
    });
  });

  describe("startSync", () => {
    it("starts the client and waits for PREPARED state", async () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await startSync(client);

      expect(mockClient.startClient).toHaveBeenCalledWith({
        initialSyncLimit: 20,
      });
      expect(mockClient.once).toHaveBeenCalledWith(
        "sync",
        expect.any(Function)
      );
    });
  });

  describe("stopSync", () => {
    it("stops the client and clears the singleton", () => {
      getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      stopSync();

      expect(mockClient.stopClient).toHaveBeenCalled();
    });
  });

  describe("sendMessage", () => {
    it("sends a text message and returns event ID", async () => {
      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const result = await sendMessage(client, "!room1:test.local", "Hello!");

      expect(result.eventId).toBe("$evt1");
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        "!room1:test.local",
        {
          msgtype: "m.text",
          body: "Hello!",
        }
      );
    });
  });

  describe("getDmRooms", () => {
    it("returns empty array when no m.direct account data", () => {
      mockClient.getAccountData.mockReturnValue(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const rooms = getDmRooms(client);
      expect(rooms).toEqual([]);
    });

    it("filters rooms by m.direct room IDs", () => {
      const mockRoom1 = { roomId: "!dm1:test.local" };
      const mockRoom2 = { roomId: "!group1:test.local" };

      mockClient.getAccountData.mockReturnValue({
        getContent: () => ({
          "@bob:test.local": ["!dm1:test.local"],
        }),
      });
      mockClient.getRooms.mockReturnValue([mockRoom1, mockRoom2]);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const rooms = getDmRooms(client);
      expect(rooms).toHaveLength(1);
      expect(rooms[0].roomId).toBe("!dm1:test.local");
    });
  });

  describe("persistMDirectWithRetry", () => {
    beforeEach(() => {
      clearMatrixSyncRepairListenersForTesting();
      // Silence backoff delays so tests run fast. setTimeout is invoked with
      // numeric delays in production; we replace it with an immediate scheduler.
      vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
        cb();
        // Cast to satisfy NodeJS.Timeout return type; never inspected by callers.
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
    });

    it("succeeds on first attempt without emitting a failure event", async () => {
      const events: unknown[] = [];
      onMatrixSyncRepair((evt) => events.push(evt));
      mockClient.setAccountData.mockResolvedValueOnce(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await persistMDirectWithRetry(client, { "@bob:test.local": ["!r1"] });

      expect(mockClient.setAccountData).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: MATRIX_SYNC_REPAIR_SUCCEEDED,
        attempt: 1,
      });
    });

    it("retries with backoff and reports each failure", async () => {
      const events: unknown[] = [];
      onMatrixSyncRepair((evt) => events.push(evt));

      mockClient.setAccountData
        .mockRejectedValueOnce(new Error("rate limited"))
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await persistMDirectWithRetry(client, { "@bob:test.local": ["!r1"] });

      expect(mockClient.setAccountData).toHaveBeenCalledTimes(3);
      const failures = events.filter(
        (e) => (e as { type: string }).type === MATRIX_SYNC_REPAIR_FAILED,
      );
      expect(failures).toHaveLength(2);
      expect(failures[0]).toMatchObject({ attempt: 1, message: "rate limited" });
      expect(failures[1]).toMatchObject({ attempt: 2, message: "timeout" });
      const successes = events.filter(
        (e) => (e as { type: string }).type === MATRIX_SYNC_REPAIR_SUCCEEDED,
      );
      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({ attempt: 3 });
    });

    it("throws MatrixDirectRepairError after the bounded retry budget is exhausted", async () => {
      const events: unknown[] = [];
      onMatrixSyncRepair((evt) => events.push(evt));
      mockClient.setAccountData.mockRejectedValue(new Error("synapse down"));

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await expect(
        persistMDirectWithRetry(client, { "@bob:test.local": ["!r1"] }),
      ).rejects.toBeInstanceOf(MatrixDirectRepairError);

      // 4 failure events + 1 exhausted event = 5 total
      const exhausted = events.filter(
        (e) => (e as { type: string }).type === MATRIX_SYNC_REPAIR_EXHAUSTED,
      );
      expect(exhausted).toHaveLength(1);
      expect(exhausted[0]).toMatchObject({
        attempts: 4,
        message: "synapse down",
      });
    });

    it("emits MATRIX_SYNC_REPAIR_FAILED with nextRetryMs=null on the last attempt", async () => {
      const events: unknown[] = [];
      onMatrixSyncRepair((evt) => events.push(evt));
      mockClient.setAccountData.mockRejectedValue(new Error("nope"));

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      await expect(
        persistMDirectWithRetry(client, { "@bob:test.local": ["!r1"] }),
      ).rejects.toBeInstanceOf(MatrixDirectRepairError);

      const failures = events.filter(
        (e) => (e as { type: string }).type === MATRIX_SYNC_REPAIR_FAILED,
      ) as Array<{ attempt: number; nextRetryMs: number | null }>;
      expect(failures).toHaveLength(4);
      expect(failures[3].attempt).toBe(4);
      expect(failures[3].nextRetryMs).toBeNull();
      // Earlier attempts must have a positive backoff delay.
      for (const f of failures.slice(0, 3)) {
        expect(f.nextRetryMs).not.toBeNull();
        expect(f.nextRetryMs as number).toBeGreaterThan(0);
      }
    });
  });

  describe("getOrCreateDmRoom", () => {
    it("creates a new room when no existing DM found", async () => {
      mockClient.getRooms.mockReturnValue([]);
      mockClient.getAccountData.mockReturnValue({
        getContent: () => ({}),
      });
      mockClient.setAccountData.mockResolvedValue(undefined);

      const client = getMatrixClient({
        homeserverUrl: "https://matrix.test.local",
        userId: "@user1:test.local",
        accessToken: "token123",
      });

      const roomId = await getOrCreateDmRoom(client, "@newuser:test.local");

      expect(roomId).toBe("!newroom:test.local");
      expect(mockClient.createRoom).toHaveBeenCalledWith({
        is_direct: true,
        invite: ["@newuser:test.local"],
        preset: "trusted_private_chat",
      });
    });
  });
});
