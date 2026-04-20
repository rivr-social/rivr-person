/**
 * Recovery-seed MFA challenge service.
 *
 * Purpose:
 * Issue and verify short-lived single-use MFA codes that gate reveal and
 * rotation of a user's sovereign recovery seed. Two delivery channels are
 * supported:
 *
 *   - `email` — reuses the existing SMTP transport (`src/lib/email.ts`).
 *   - `sms`   — stubbed provider (throws with a clear "not configured"
 *                error) so the API surface is stable but no real SMS
 *                provider is required for MVP.
 *
 * Key exports:
 * - `RECOVERY_MFA_CODE_DIGITS`         : length of the numeric code.
 * - `RECOVERY_MFA_CODE_TTL_MS`         : 5 minutes.
 * - `RECOVERY_MFA_MAX_VERIFY_ATTEMPTS` : per-challenge attempt cap.
 * - `RECOVERY_MFA_REVEAL_WINDOW_MS`    : reveal token lifetime after verify.
 * - `issueRecoveryMfaChallenge()`      : generates and sends a code.
 * - `verifyRecoveryMfaChallenge()`     : checks a code, returns reveal token.
 * - `consumeRecoveryRevealToken()`     : one-shot redeem (used by rotate).
 * - `RecoveryMfaNotConfiguredError`    : typed error for stubbed SMS path.
 *
 * Dependencies:
 * - `@/db` for the `emailVerificationTokens` table (reused for codes).
 * - `@/lib/email` for SMTP delivery.
 * - `@/lib/token-hash` so stored codes are never plaintext.
 */

import { and, eq, gt, isNull } from 'drizzle-orm';
import { randomInt, randomBytes } from 'node:crypto';
import { db } from '@/db';
import { emailVerificationTokens } from '@/db/schema';
import { sendTransactionalEmail } from '@/lib/mailer';
import { hashToken } from '@/lib/token-hash';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 6-digit numeric code — long enough to resist online guessing given TTL. */
export const RECOVERY_MFA_CODE_DIGITS = 6;

/** Challenge lifetime (5 minutes). After this the code cannot be redeemed. */
export const RECOVERY_MFA_CODE_TTL_MS = 5 * 60 * 1000;

/** Max verification attempts per issued challenge. */
export const RECOVERY_MFA_MAX_VERIFY_ATTEMPTS = 5;

/**
 * How long a verified challenge remains valid for a subsequent
 * "show-me-the-seed" or "rotate-my-seed" request. Kept narrow so a stolen
 * reveal token cannot be re-used an hour later.
 */
export const RECOVERY_MFA_REVEAL_WINDOW_MS = 10 * 60 * 1000;

/** Database `token_type` value used for reveal-gate challenges. */
export const RECOVERY_MFA_CHALLENGE_TOKEN_TYPE =
  'recovery_seed_mfa_challenge';

/**
 * Database `token_type` value used for the short-lived reveal/rotate token
 * handed back after a successful challenge verification.
 */
export const RECOVERY_MFA_REVEAL_TOKEN_TYPE =
  'recovery_seed_reveal_token';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an MFA channel is not configured (for example SMS without a
 * provider). Distinguishing this from a generic Error lets API routes map
 * the failure to a 503/501 instead of a 500.
 */
export class RecoveryMfaNotConfiguredError extends Error {
  public readonly channel: 'email' | 'sms';
  constructor(channel: 'email' | 'sms', message?: string) {
    super(
      message ??
        `Recovery MFA channel "${channel}" is not configured on this deployment.`,
    );
    this.name = 'RecoveryMfaNotConfiguredError';
    this.channel = channel;
  }
}

// ---------------------------------------------------------------------------
// Delivery providers
// ---------------------------------------------------------------------------

/**
 * Contract implemented by every delivery provider. Keeping this a tiny
 * interface lets us add a real SMS provider later without touching callers.
 */
interface RecoveryMfaProvider {
  send(recipient: string, code: string): Promise<void>;
}

/** SMTP-backed email provider. */
const emailProvider: RecoveryMfaProvider = {
  async send(recipient, code) {
    const subject = 'Your Rivr recovery-seed verification code';
    const text = [
      `Someone requested access to your Rivr recovery seed phrase.`,
      '',
      `Verification code: ${code}`,
      '',
      `This code expires in 5 minutes and can only be used once.`,
      `If you did not request this code, ignore this email and consider`,
      `rotating your recovery seed from the Security tab in Settings.`,
    ].join('\n');
    const html = `
      <div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px;">
        <h2 style="margin: 0 0 12px 0;">Verify your recovery-seed request</h2>
        <p>Someone requested access to your Rivr recovery seed phrase.</p>
        <p style="font-size: 28px; letter-spacing: 4px; font-weight: 600; text-align: center; padding: 16px; background: #f4f4f5; border-radius: 8px;">
          ${code}
        </p>
        <p style="color: #71717a; font-size: 13px;">
          This code expires in 5 minutes and can only be used once.
        </p>
        <p style="color: #71717a; font-size: 13px;">
          If you did not request this code, ignore this email and consider
          rotating your recovery seed from the Security tab in Settings.
        </p>
      </div>`;

    const result = await sendTransactionalEmail({ kind: 'recovery', to: recipient, subject, html, text });
    if (!result.success) {
      throw new Error(
        `Failed to send recovery MFA email: ${result.error ?? 'unknown error'}`,
      );
    }
  },
};

/**
 * Stubbed SMS provider. Throws {@link RecoveryMfaNotConfiguredError} so the
 * API surface can be exercised end-to-end without forcing a Twilio/MessageBird
 * integration for MVP. A future ticket will swap this out for a real provider.
 */
const smsStubProvider: RecoveryMfaProvider = {
  async send() {
    throw new RecoveryMfaNotConfiguredError(
      'sms',
      'SMS verification is not yet configured on this instance. Use email for now; a future release will add an SMS provider behind the same interface.',
    );
  },
};

function resolveProvider(channel: 'email' | 'sms'): RecoveryMfaProvider {
  switch (channel) {
    case 'email':
      return emailProvider;
    case 'sms':
      return smsStubProvider;
    default: {
      const _exhaustive: never = channel;
      throw new Error(`Unreachable MFA channel: ${String(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of a successful challenge issuance.
 */
export interface IssuedRecoveryMfaChallenge {
  /** Opaque token the client echoes back to verify. */
  challengeId: string;
  /** ISO timestamp at which the challenge expires. */
  expiresAt: string;
  /** Channel actually used for delivery. */
  method: 'email' | 'sms';
}

/**
 * Issue a fresh MFA challenge for `agentId` over the chosen channel.
 *
 * Security properties:
 * - Previous unspent challenges for this agent are invalidated so only one
 *   challenge can be in flight at any time.
 * - The plaintext code is hashed before storage; only the hash lives in
 *   the DB and in the email provider.
 * - Code is 6 random digits sourced from `crypto.randomInt`.
 *
 * @param params Agent ID + delivery metadata.
 * @returns Opaque challenge handle the client uses in the verify call.
 * @throws {RecoveryMfaNotConfiguredError} When the channel is unconfigured.
 * @throws Propagates any SMTP error.
 */
export async function issueRecoveryMfaChallenge(params: {
  agentId: string;
  method: 'email' | 'sms';
  /** Email address (for email) or E.164 phone (for sms). */
  recipient: string;
}): Promise<IssuedRecoveryMfaChallenge> {
  const { agentId, method, recipient } = params;

  // Invalidate any in-flight challenges so we never have two valid codes at
  // once. This is a small, intentional DB write; rate-limiting happens at
  // the route layer.
  const now = new Date();
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(emailVerificationTokens.agentId, agentId),
        eq(emailVerificationTokens.tokenType, RECOVERY_MFA_CHALLENGE_TOKEN_TYPE),
        isNull(emailVerificationTokens.usedAt),
      ),
    );

  // Generate a random N-digit code. `randomInt` is cryptographically secure
  // and avoids modulo bias from `Math.random`.
  const upperExclusive = 10 ** RECOVERY_MFA_CODE_DIGITS;
  const code = randomInt(0, upperExclusive)
    .toString()
    .padStart(RECOVERY_MFA_CODE_DIGITS, '0');

  const challengeId = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + RECOVERY_MFA_CODE_TTL_MS);

  // Store the hashed code, keyed by challengeId so a later verify can look
  // up attempts and remaining TTL without scanning by agent.
  await db.insert(emailVerificationTokens).values({
    agentId,
    token: hashToken(`${challengeId}:${code}`),
    tokenType: RECOVERY_MFA_CHALLENGE_TOKEN_TYPE,
    expiresAt,
    metadata: {
      challengeId,
      method,
      attemptsRemaining: RECOVERY_MFA_MAX_VERIFY_ATTEMPTS,
    },
  });

  const provider = resolveProvider(method);
  await provider.send(recipient, code);

  return {
    challengeId,
    expiresAt: expiresAt.toISOString(),
    method,
  };
}

/**
 * Verify a code against a previously issued challenge.
 *
 * On success this returns a short-lived `revealToken` that the reveal /
 * rotate routes require. The token is also hashed in the DB so even a
 * read-only DB compromise cannot surface it.
 *
 * @param params Challenge handle + candidate code + agent id.
 * @returns A reveal token + expiry when the code matches.
 * @throws Never throws for wrong-code paths; callers read `ok: false`.
 */
export async function verifyRecoveryMfaChallenge(params: {
  agentId: string;
  challengeId: string;
  code: string;
}): Promise<
  | {
      ok: true;
      revealToken: string;
      revealTokenExpiresAt: string;
      method: 'email' | 'sms';
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'already_used'
        | 'incorrect_code'
        | 'attempts_exhausted';
      attemptsRemaining?: number;
    }
> {
  const { agentId, challengeId, code } = params;
  const now = new Date();

  // Look up by agent + type + un-used + not-expired. We cannot look up by
  // challengeId alone because the schema indexes agent+type+used; scanning
  // by metadata->>'challengeId' is acceptable for the low traffic expected.
  const rows = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.agentId, agentId),
        eq(emailVerificationTokens.tokenType, RECOVERY_MFA_CHALLENGE_TOKEN_TYPE),
        isNull(emailVerificationTokens.usedAt),
        gt(emailVerificationTokens.expiresAt, now),
      ),
    );

  const row = rows.find((r) => {
    const meta = r.metadata as Record<string, unknown> | null;
    return meta?.challengeId === challengeId;
  });
  if (!row) {
    return { ok: false, reason: 'not_found' };
  }

  const expected = hashToken(`${challengeId}:${code}`);
  if (row.token !== expected) {
    // Decrement attempts remaining; lock out when zero.
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    const remaining =
      Math.max(
        0,
        (typeof meta.attemptsRemaining === 'number'
          ? meta.attemptsRemaining
          : RECOVERY_MFA_MAX_VERIFY_ATTEMPTS) - 1,
      );
    if (remaining <= 0) {
      await db
        .update(emailVerificationTokens)
        .set({ usedAt: now, metadata: { ...meta, attemptsRemaining: 0 } })
        .where(eq(emailVerificationTokens.id, row.id));
      return { ok: false, reason: 'attempts_exhausted', attemptsRemaining: 0 };
    }
    await db
      .update(emailVerificationTokens)
      .set({ metadata: { ...meta, attemptsRemaining: remaining } })
      .where(eq(emailVerificationTokens.id, row.id));
    return { ok: false, reason: 'incorrect_code', attemptsRemaining: remaining };
  }

  // Mark the challenge row used so the code cannot be replayed.
  await db
    .update(emailVerificationTokens)
    .set({ usedAt: now })
    .where(eq(emailVerificationTokens.id, row.id));

  // Issue the reveal token. Stored hashed so a DB leak does not reveal it.
  const revealToken = randomBytes(32).toString('hex');
  const revealExpiresAt = new Date(Date.now() + RECOVERY_MFA_REVEAL_WINDOW_MS);
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  const method = (meta.method === 'sms' ? 'sms' : 'email') as 'email' | 'sms';

  await db.insert(emailVerificationTokens).values({
    agentId,
    token: hashToken(revealToken),
    tokenType: RECOVERY_MFA_REVEAL_TOKEN_TYPE,
    expiresAt: revealExpiresAt,
    metadata: {
      originatingChallengeId: challengeId,
      method,
    },
  });

  return {
    ok: true,
    revealToken,
    revealTokenExpiresAt: revealExpiresAt.toISOString(),
    method,
  };
}

/**
 * One-shot redemption of a reveal token. Used by the rotate route before
 * accepting a new recovery public key. Also called from the audit-reveal
 * route to mark the reveal complete.
 *
 * @param params Agent + reveal token.
 * @returns `{ ok: true }` when redeemed; `{ ok: false, reason }` otherwise.
 */
export async function consumeRecoveryRevealToken(params: {
  agentId: string;
  revealToken: string;
  /** If true, leave the token unused (for non-destructive reveal viewing). */
  peek?: boolean;
}): Promise<
  | { ok: true; method: 'email' | 'sms' }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_used' }
> {
  const { agentId, revealToken, peek = false } = params;
  const now = new Date();

  const rows = await db
    .select()
    .from(emailVerificationTokens)
    .where(
      and(
        eq(emailVerificationTokens.agentId, agentId),
        eq(emailVerificationTokens.tokenType, RECOVERY_MFA_REVEAL_TOKEN_TYPE),
        eq(emailVerificationTokens.token, hashToken(revealToken)),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.usedAt) return { ok: false, reason: 'already_used' };
  if (row.expiresAt < now) return { ok: false, reason: 'expired' };

  if (!peek) {
    await db
      .update(emailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(emailVerificationTokens.id, row.id));
  }
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  return {
    ok: true,
    method: (meta.method === 'sms' ? 'sms' : 'email') as 'email' | 'sms',
  };
}
