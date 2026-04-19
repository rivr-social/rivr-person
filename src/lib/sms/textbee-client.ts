/**
 * TextBee SMS Gateway client for sending/receiving SMS via self-hosted Android devices.
 *
 * Purpose:
 * - Wraps the TextBee REST API (https://github.com/vernu/textbee) into a typed client.
 * - Provides send, bulk-send, inbox retrieval, and health check operations.
 * - Handles authentication via API key header and structured error propagation.
 *
 * Key exports:
 * - `TextBeeClient` — stateful client bound to a specific gateway URL and API key.
 * - `TextBeeError` — typed error class with HTTP status and upstream error details.
 * - `TextBeeMessage`, `TextBeeSendResult`, `TextBeeBulkSendResult` — response shape types.
 * - `createTextBeeClientFromMetadata` — factory to build a client from group agent metadata.
 *
 * Dependencies:
 * - Native `fetch` API (no external HTTP library).
 */

// =============================================================================
// Constants
// =============================================================================

/** Default request timeout in milliseconds to prevent hanging connections. */
const REQUEST_TIMEOUT_MS = 15_000;

/** Maximum recipients per bulk SMS call to prevent gateway overload. */
const MAX_BULK_RECIPIENTS = 100;

/** TextBee API path segments. */
const API_PATHS = {
  SEND_SMS: "/api/messages/send",
  SEND_BULK_SMS: "/api/messages/send-bulk",
  GET_MESSAGES: "/api/messages",
  GET_DEVICE: "/api/devices",
} as const;

// =============================================================================
// Error types
// =============================================================================

/**
 * Structured error for TextBee API failures.
 *
 * Carries the HTTP status code and upstream error message so callers
 * can distinguish transient network failures from validation rejections.
 */
export class TextBeeError extends Error {
  public readonly statusCode: number;
  public readonly upstream: string | null;

  constructor(message: string, statusCode: number, upstream?: string) {
    super(message);
    this.name = "TextBeeError";
    this.statusCode = statusCode;
    this.upstream = upstream ?? null;
  }
}

// =============================================================================
// Response types
// =============================================================================

/** Shape of a single inbound or outbound SMS message from the TextBee API. */
export type TextBeeMessage = {
  id: string;
  message: string;
  phoneNumber: string;
  receivedAt: string;
  type: "received" | "sent";
};

/** Result of a single send operation. */
export type TextBeeSendResult = {
  success: boolean;
  messageId?: string;
  error?: string;
};

/** Result of a bulk send operation. */
export type TextBeeBulkSendResult = {
  success: boolean;
  totalSent: number;
  totalFailed: number;
  errors: Array<{ recipient: string; error: string }>;
};

/** Gateway device status returned by the health check. */
export type TextBeeDeviceStatus = {
  online: boolean;
  deviceId?: string;
  lastSeen?: string;
};

// =============================================================================
// Configuration type
// =============================================================================

/** Configuration required to instantiate a TextBee client. */
export type TextBeeConfig = {
  /** Base URL of the TextBee server (e.g. "https://textbee.example.com"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Optional device ID to target a specific Android device. */
  deviceId?: string;
};

// =============================================================================
// Client
// =============================================================================

/**
 * Typed HTTP client for the TextBee SMS gateway REST API.
 *
 * Each group's gateway configuration produces a separate client instance,
 * ensuring API keys and URLs are scoped per-group.
 */
export class TextBeeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly deviceId: string | undefined;

  constructor(config: TextBeeConfig) {
    // Strip trailing slash to prevent double-slash in URL construction.
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.deviceId = config.deviceId;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Sends a single SMS message to a phone number.
   *
   * @param to - E.164 formatted phone number (e.g. "+15551234567").
   * @param message - SMS body text (max 160 chars for single segment).
   * @returns Send result with message ID on success.
   * @throws {TextBeeError} On network or API-level failures.
   */
  async sendSms(to: string, message: string): Promise<TextBeeSendResult> {
    const normalizedTo = this.normalizePhoneNumber(to);

    const response = await this.request<{ data?: { id?: string }; message?: string }>(
      API_PATHS.SEND_SMS,
      "POST",
      {
        receivers: [normalizedTo],
        message,
        ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      }
    );

    return {
      success: true,
      messageId: response.data?.id ?? undefined,
    };
  }

  /**
   * Sends the same SMS message to multiple recipients.
   *
   * @param recipients - Array of E.164 phone numbers.
   * @param message - SMS body text.
   * @returns Bulk result with per-recipient error details.
   * @throws {TextBeeError} On complete API failures (partial failures are returned inline).
   */
  async sendBulkSms(
    recipients: string[],
    message: string
  ): Promise<TextBeeBulkSendResult> {
    if (recipients.length === 0) {
      return { success: true, totalSent: 0, totalFailed: 0, errors: [] };
    }

    if (recipients.length > MAX_BULK_RECIPIENTS) {
      throw new TextBeeError(
        `Bulk SMS limited to ${MAX_BULK_RECIPIENTS} recipients per call.`,
        400
      );
    }

    const normalizedRecipients = recipients.map((r) => this.normalizePhoneNumber(r));

    const response = await this.request<{
      data?: { sent?: number; failed?: number; errors?: Array<{ receiver?: string; error?: string }> };
      message?: string;
    }>(API_PATHS.SEND_SMS, "POST", {
      receivers: normalizedRecipients,
      message,
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
    });

    const sent = response.data?.sent ?? normalizedRecipients.length;
    const failed = response.data?.failed ?? 0;
    const errors = (response.data?.errors ?? []).map((e) => ({
      recipient: e.receiver ?? "unknown",
      error: e.error ?? "Unknown error",
    }));

    return {
      success: failed === 0,
      totalSent: sent,
      totalFailed: failed,
      errors,
    };
  }

  /**
   * Fetches received SMS messages (inbox) from the gateway.
   *
   * @param since - Optional date filter to only return messages received after this timestamp.
   * @returns Array of inbound SMS messages.
   * @throws {TextBeeError} On network or API-level failures.
   */
  async getInbox(since?: Date): Promise<TextBeeMessage[]> {
    const params = new URLSearchParams({ type: "received" });
    if (since) {
      params.set("since", since.toISOString());
    }

    const response = await this.request<{ data?: TextBeeMessage[] }>(
      `${API_PATHS.GET_MESSAGES}?${params.toString()}`,
      "GET"
    );

    return response.data ?? [];
  }

  /**
   * Checks the health/connectivity of the gateway by fetching device status.
   *
   * @returns Device online status and metadata.
   * @throws {TextBeeError} On network or API-level failures.
   */
  async checkHealth(): Promise<TextBeeDeviceStatus> {
    try {
      const response = await this.request<{
        data?: Array<{ _id?: string; enabled?: boolean; lastActivityAt?: string }>;
      }>(API_PATHS.GET_DEVICE, "GET");

      const devices = response.data ?? [];
      if (devices.length === 0) {
        return { online: false };
      }

      // Use the first active device or fall back to the first device.
      const device = devices.find((d) => d.enabled) ?? devices[0];

      return {
        online: Boolean(device.enabled),
        deviceId: device._id,
        lastSeen: device.lastActivityAt,
      };
    } catch (err) {
      if (err instanceof TextBeeError) {
        return { online: false };
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Performs an authenticated HTTP request to the TextBee API.
   *
   * Applies timeout, API key header, and structured error parsing.
   */
  private async request<T>(
    path: string,
    method: "GET" | "POST" | "DELETE",
    body?: Record<string, unknown>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const headers: Record<string, string> = {
        "x-api-key": this.apiKey,
        "Accept": "application/json",
      };

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method !== "GET") {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      const response = await fetch(url, init);

      if (!response.ok) {
        let errorMessage = `TextBee API error: ${response.status} ${response.statusText}`;
        let upstream: string | undefined;
        try {
          const errorBody = await response.json() as Record<string, unknown>;
          if (typeof errorBody.message === "string") {
            errorMessage = errorBody.message;
            upstream = errorBody.message;
          }
        } catch {
          // Response body was not JSON; use the status-based message.
        }
        throw new TextBeeError(errorMessage, response.status, upstream);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof TextBeeError) throw err;

      if (err instanceof DOMException && err.name === "AbortError") {
        throw new TextBeeError(
          `TextBee request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          408
        );
      }

      throw new TextBeeError(
        `Failed to connect to TextBee gateway at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        502
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Normalizes a phone number to a consistent format.
   * Strips whitespace, dashes, and parentheses. Ensures "+" prefix.
   */
  private normalizePhoneNumber(phone: string): string {
    const stripped = phone.replace(/[\s\-()]/g, "");
    return stripped.startsWith("+") ? stripped : `+${stripped}`;
  }
}

// =============================================================================
// Factory helper
// =============================================================================

/**
 * Creates a TextBeeClient from group agent metadata.
 *
 * @param metadata - The group's metadata JSONB object.
 * @returns A configured client, or `null` if the group has no SMS gateway configured.
 */
export function createTextBeeClientFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): TextBeeClient | null {
  if (!metadata) return null;

  const textbeeUrl = typeof metadata.textbeeUrl === "string" ? metadata.textbeeUrl : null;
  const textbeeApiKey = typeof metadata.textbeeApiKey === "string" ? metadata.textbeeApiKey : null;
  const textbeeDeviceId = typeof metadata.textbeeDeviceId === "string" ? metadata.textbeeDeviceId : undefined;

  if (!textbeeUrl || !textbeeApiKey) return null;

  return new TextBeeClient({
    baseUrl: textbeeUrl,
    apiKey: textbeeApiKey,
    deviceId: textbeeDeviceId,
  });
}
