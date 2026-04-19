import "server-only";

import crypto from "node:crypto";
import https from "node:https";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";

const TELLER_PROVIDER = "teller_bank";
const TELLER_API_BASE_URL = "https://api.teller.io";
const TELLER_API_VERSION = "2020-10-12";
const DEFAULT_TELLER_PRODUCTS = [
  "balance",
  "transactions",
  "identity",
  "verify",
  "payments",
] as const;

type TellerEnvironment = "sandbox" | "development" | "production";

type TellerAccountRecord = {
  id: string;
  providerAccountId: string;
  accessToken: string | null;
  tokenType: string | null;
  institutionName: string | null;
  tellerUserId: string | null;
};

type TellerLinks = Record<string, string | undefined>;

type TellerApiAccount = {
  id: string;
  enrollment_id: string;
  name: string;
  subtype: string;
  type: string;
  currency: string;
  last_four: string;
  status: string;
  institution?: {
    id?: string;
    name?: string;
  };
  links?: TellerLinks;
};

type TellerApiBalances = {
  account_id: string;
  available?: string | null;
  ledger?: string | null;
};

type TellerPaymentSchemesResponse = {
  schemes?: Array<{ name?: string }>;
};

type TellerPaymentResponse = {
  id?: string;
  amount?: string;
  memo?: string;
  reference?: string;
  date?: string;
  connect_token?: string;
};

export type TellerBankAccountSummary = {
  id: string;
  enrollmentId: string;
  tellerUserId?: string | null;
  institutionId?: string | null;
  institutionName: string;
  name: string;
  subtype: string;
  type: string;
  currency: string;
  lastFour: string;
  status: string;
  available?: string | null;
  ledger?: string | null;
  supportsPayments: boolean;
  paymentSchemes: string[];
  sourceProvider: string;
};

export type TellerPaymentInput = {
  sourceAccountId: string;
  amount: string;
  memo?: string;
  payeeAddress: string;
  payeeName?: string;
  payeeType?: "person" | "business";
};

export type TellerWebhookEvent = {
  id: string;
  type:
    | "enrollment.disconnected"
    | "transactions.processed"
    | "account.number_verification.processed"
    | "webhook.test"
    | string;
  timestamp: string;
  payload: {
    enrollment_id?: string;
    account_id?: string;
    reason?: string;
    status?: string;
    transactions?: Array<Record<string, unknown>>;
  };
};

function normalizeMultilineEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\\n/g, "\n");
}

export function getTellerEnvironment(): TellerEnvironment {
  const raw = process.env.TELLER_ENVIRONMENT?.trim().toLowerCase();
  if (raw === "development" || raw === "production" || raw === "sandbox") {
    return raw;
  }
  return "sandbox";
}

export function getTellerClientConfig() {
  const applicationId = process.env.TELLER_APPLICATION_ID?.trim() ?? "";
  const environment = getTellerEnvironment();
  const cert = normalizeMultilineEnv(process.env.TELLER_CERT_PEM);
  const key = normalizeMultilineEnv(process.env.TELLER_KEY_PEM);

  return {
    applicationId,
    environment,
    products: [...DEFAULT_TELLER_PRODUCTS],
    connectConfigured: Boolean(applicationId),
    apiConfigured:
      environment === "sandbox" ? true : Boolean(cert?.trim() && key?.trim()),
  };
}

function getTellerHttpsAgent(): https.Agent | undefined {
  const environment = getTellerEnvironment();
  const cert = normalizeMultilineEnv(process.env.TELLER_CERT_PEM);
  const key = normalizeMultilineEnv(process.env.TELLER_KEY_PEM);

  if (environment === "sandbox" && (!cert || !key)) {
    return undefined;
  }

  if (!cert || !key) {
    throw new Error(
      `Teller API requests in ${environment} require TELLER_CERT_PEM and TELLER_KEY_PEM.`,
    );
  }

  return new https.Agent({
    cert,
    key,
    keepAlive: true,
  });
}

async function tellerRequest<T>(
  path: string,
  options: {
    token: string;
    method?: "GET" | "POST" | "OPTIONS" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
  },
): Promise<T> {
  const url = new URL(path, TELLER_API_BASE_URL);
  const agent = getTellerHttpsAgent();
  const method = options.method ?? "GET";

  return await new Promise<T>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        agent,
        headers: {
          Authorization: `Basic ${Buffer.from(`${options.token}:`).toString("base64")}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "Teller-Version": TELLER_API_VERSION,
          ...(options.idempotencyKey
            ? { "Idempotency-Key": options.idempotencyKey }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          const status = res.statusCode ?? 500;

          if (status >= 400) {
            reject(
              new Error(
                raw
                  ? `Teller API error (${status}): ${raw.slice(0, 500)}`
                  : `Teller API error (${status})`,
              ),
            );
            return;
          }

          if (!raw) {
            resolve(undefined as T);
            return;
          }

          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            reject(new Error("Teller API returned malformed JSON."));
          }
        });
      },
    );

    req.on("error", reject);

    if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }

    req.end();
  });
}

export async function listTellerEnrollmentRecords(
  userId: string,
): Promise<TellerAccountRecord[]> {
  return await db
    .select({
      id: accounts.id,
      providerAccountId: accounts.providerAccountId,
      accessToken: accounts.access_token,
      tokenType: accounts.token_type,
      institutionName: accounts.session_state,
      tellerUserId: accounts.id_token,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, TELLER_PROVIDER)));
}

async function getTellerPaymentSchemes(
  token: string,
  account: TellerApiAccount,
): Promise<string[]> {
  if (!account.links?.payments) return [];
  const response = await tellerRequest<TellerPaymentSchemesResponse>(
    `/accounts/${account.id}/payments`,
    { token, method: "OPTIONS" },
  );
  return Array.isArray(response.schemes)
    ? response.schemes
        .map((scheme) => (typeof scheme?.name === "string" ? scheme.name.trim() : ""))
        .filter(Boolean)
    : [];
}

export async function listLinkedTellerBankAccounts(
  userId: string,
): Promise<TellerBankAccountSummary[]> {
  const enrollments = await listTellerEnrollmentRecords(userId);
  const byAccountId = new Map<string, TellerBankAccountSummary>();

  await Promise.all(
    enrollments.map(async (enrollment) => {
      if (!enrollment.accessToken) return;

      const enrollmentAccounts = await tellerRequest<TellerApiAccount[]>("/accounts", {
        token: enrollment.accessToken,
      });

      await Promise.all(
        enrollmentAccounts.map(async (account) => {
          const [balances, paymentSchemes] = await Promise.all([
            account.links?.balances
              ? tellerRequest<TellerApiBalances>(`/accounts/${account.id}/balances`, {
                  token: enrollment.accessToken!,
                }).catch(() => null)
              : Promise.resolve(null),
            getTellerPaymentSchemes(enrollment.accessToken!, account).catch(() => []),
          ]);

          byAccountId.set(account.id, {
            id: account.id,
            enrollmentId: account.enrollment_id || enrollment.providerAccountId,
            tellerUserId: enrollment.tellerUserId,
            institutionId: account.institution?.id ?? null,
            institutionName:
              account.institution?.name?.trim() ||
              enrollment.institutionName?.trim() ||
              "Linked Bank",
            name: account.name,
            subtype: account.subtype,
            type: account.type,
            currency: account.currency,
            lastFour: account.last_four,
            status: account.status,
            available: balances?.available ?? null,
            ledger: balances?.ledger ?? null,
            supportsPayments: paymentSchemes.length > 0,
            paymentSchemes,
            sourceProvider: TELLER_PROVIDER,
          });
        }),
      );
    }),
  );

  return [...byAccountId.values()].sort((a, b) =>
    `${a.institutionName}:${a.name}`.localeCompare(`${b.institutionName}:${b.name}`),
  );
}

export async function saveTellerEnrollment(input: {
  userId: string;
  enrollmentId: string;
  accessToken: string;
  tellerUserId?: string | null;
  institutionName?: string | null;
}) {
  const existing = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, input.userId),
        eq(accounts.provider, TELLER_PROVIDER),
        eq(accounts.providerAccountId, input.enrollmentId),
      ),
    )
    .limit(1);

  const values = {
    access_token: input.accessToken,
    token_type: getTellerEnvironment(),
    scope: DEFAULT_TELLER_PRODUCTS.join(" "),
    id_token: input.tellerUserId?.trim() || null,
    session_state: input.institutionName?.trim() || null,
  };

  if (existing[0]) {
    await db.update(accounts).set(values).where(eq(accounts.id, existing[0].id));
    return;
  }

  await db.insert(accounts).values({
    userId: input.userId,
    type: "oauth",
    provider: TELLER_PROVIDER,
    providerAccountId: input.enrollmentId,
    ...values,
  });
}

function getTellerSigningKey(): crypto.KeyObject | undefined {
  const raw = normalizeMultilineEnv(process.env.TELLER_SIGNING_PUBLIC_KEY);
  if (!raw) return undefined;

  if (raw.includes("BEGIN PUBLIC KEY")) {
    return crypto.createPublicKey(raw);
  }

  return crypto.createPublicKey({
    key: Buffer.from(raw, "base64"),
    format: "der",
    type: "spki",
  });
}

export function verifyTellerEnrollmentSignature(input: {
  nonce: string;
  accessToken: string;
  tellerUserId: string;
  enrollmentId: string;
  signatures: string[];
}) {
  const key = getTellerSigningKey();
  if (!key) {
    return true;
  }

  const payload = [
    input.nonce,
    input.accessToken,
    input.tellerUserId,
    input.enrollmentId,
    getTellerEnvironment(),
  ].join(".");
  const digest = crypto.createHash("sha256").update(payload).digest();

  return input.signatures.some((signature) => {
    try {
      return crypto.verify(null, digest, key, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  });
}

export async function initiateTellerPayment(
  userId: string,
  input: TellerPaymentInput,
): Promise<TellerPaymentResponse> {
  const accountsForUser = await listTellerEnrollmentRecords(userId);

  for (const enrollment of accountsForUser) {
    if (!enrollment.accessToken) continue;
    const tellerAccounts = await tellerRequest<TellerApiAccount[]>("/accounts", {
      token: enrollment.accessToken,
    });
    const sourceAccount = tellerAccounts.find((account) => account.id === input.sourceAccountId);
    if (!sourceAccount) continue;

    const paymentSchemes = await getTellerPaymentSchemes(enrollment.accessToken, sourceAccount);
    if (!paymentSchemes.includes("zelle")) {
      throw new Error("This linked account does not currently support Teller payments.");
    }

    return await tellerRequest<TellerPaymentResponse>(
      `/accounts/${input.sourceAccountId}/payments`,
      {
        token: enrollment.accessToken,
        method: "POST",
        idempotencyKey: crypto.randomUUID(),
        body: {
          amount: input.amount,
          memo: input.memo?.trim() || undefined,
          payee: {
            scheme: "zelle",
            address: input.payeeAddress.trim(),
            ...(input.payeeName?.trim()
              ? {
                  name: input.payeeName.trim(),
                  type: input.payeeType ?? "person",
                }
              : {}),
          },
        },
      },
    );
  }

  throw new Error("Linked Teller source account not found.");
}

export function createTellerConnectNonce(): string {
  return crypto.randomBytes(24).toString("hex");
}

function getTellerWebhookSecrets(): string[] {
  const raw = process.env.TELLER_WEBHOOK_SECRET?.trim();
  if (!raw) return [];

  return raw
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function verifyTellerWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  now?: number;
}) {
  const secrets = getTellerWebhookSecrets();
  if (secrets.length === 0) {
    throw new Error("TELLER_WEBHOOK_SECRET is not configured.");
  }

  if (!input.signatureHeader?.trim()) {
    throw new Error("Missing Teller-Signature header.");
  }

  const segments = input.signatureHeader
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const timestampSegment = segments.find((segment) => segment.startsWith("t="));
  const signatureValues = segments
    .filter((segment) => segment.startsWith("v1="))
    .map((segment) => segment.slice(3))
    .filter(Boolean);

  if (!timestampSegment || signatureValues.length === 0) {
    throw new Error("Malformed Teller-Signature header.");
  }

  const timestamp = Number(timestampSegment.slice(2));
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid Teller signature timestamp.");
  }

  const now = typeof input.now === "number" ? input.now : Date.now();
  if (Math.abs(now - timestamp * 1000) > 3 * 60 * 1000) {
    throw new Error("Teller webhook signature timestamp is outside the allowed replay window.");
  }

  const signedMessage = `${timestamp}.${input.rawBody}`;

  const isValid = secrets.some((secret) => {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(signedMessage)
      .digest("hex");
    return signatureValues.some((signature) =>
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)),
    );
  });

  if (!isValid) {
    throw new Error("Invalid Teller webhook signature.");
  }
}

async function findTellerUserIdsByAccountId(accountId: string): Promise<string[]> {
  const enrollments = await db
    .select({
      userId: accounts.userId,
      accessToken: accounts.access_token,
    })
    .from(accounts)
    .where(eq(accounts.provider, TELLER_PROVIDER));

  const matches = new Set<string>();

  await Promise.all(
    enrollments.map(async (enrollment) => {
      if (!enrollment.accessToken) return;
      try {
        const tellerAccounts = await tellerRequest<TellerApiAccount[]>("/accounts", {
          token: enrollment.accessToken,
        });
        if (tellerAccounts.some((account) => account.id === accountId)) {
          matches.add(enrollment.userId);
        }
      } catch {
        // Ignore stale/broken enrollments while resolving the target user.
      }
    }),
  );

  return [...matches];
}

async function resolveTellerWebhookUserIds(
  payload: TellerWebhookEvent["payload"],
): Promise<string[]> {
  if (payload.enrollment_id?.trim()) {
    const rows = await db
      .select({ userId: accounts.userId })
      .from(accounts)
      .where(
        and(
          eq(accounts.provider, TELLER_PROVIDER),
          eq(accounts.providerAccountId, payload.enrollment_id.trim()),
        ),
      );

    return [...new Set(rows.map((row) => row.userId))];
  }

  if (payload.account_id?.trim()) {
    return await findTellerUserIdsByAccountId(payload.account_id.trim());
  }

  return [];
}

async function patchTellerConnectionState(
  userId: string,
  patch: {
    status?: "connected" | "needs_auth" | "error";
    lastSyncedAt?: string;
    error?: string;
  },
) {
  const settings = await getAutobotUserSettings(userId);
  const tellerConnection = settings.connections.find(
    (connection) => connection.provider === "teller",
  );

  if (!tellerConnection) return;

  const connections = settings.connections.map((connection) =>
    connection.provider === "teller"
      ? {
          ...connection,
          status: patch.status ?? connection.status,
          lastSyncedAt: patch.lastSyncedAt ?? connection.lastSyncedAt,
          error: patch.error,
        }
      : connection,
  );

  await saveAutobotUserSettings(userId, { connections });
}

export async function handleTellerWebhookEvent(event: TellerWebhookEvent) {
  const userIds = await resolveTellerWebhookUserIds(event.payload);

  if (event.type === "webhook.test") {
    return { ok: true, affectedUsers: 0 };
  }

  if (userIds.length === 0) {
    return { ok: true, affectedUsers: 0 };
  }

  switch (event.type) {
    case "transactions.processed": {
      await Promise.all(
        userIds.map((userId) =>
          patchTellerConnectionState(userId, {
            status: "connected",
            lastSyncedAt: event.timestamp,
            error: undefined,
          }),
        ),
      );
      break;
    }
    case "enrollment.disconnected": {
      const reason = event.payload.reason?.trim() || "Enrollment disconnected";
      await Promise.all(
        userIds.map((userId) =>
          patchTellerConnectionState(userId, {
            status: "error",
            lastSyncedAt: event.timestamp,
            error: reason,
          }),
        ),
      );
      break;
    }
    case "account.number_verification.processed": {
      const status = event.payload.status?.trim() || "completed";
      await Promise.all(
        userIds.map((userId) =>
          patchTellerConnectionState(userId, {
            status: status === "expired" ? "needs_auth" : "connected",
            lastSyncedAt: event.timestamp,
            error:
              status === "expired"
                ? "Account number verification expired."
                : undefined,
          }),
        ),
      );
      break;
    }
    default:
      break;
  }

  return { ok: true, affectedUsers: userIds.length };
}
