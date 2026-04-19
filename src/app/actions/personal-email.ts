"use server";

/**
 * Personal Email server actions for self-hosted email configuration.
 *
 * Purpose:
 * - Save email identity (address, display name, domain) to user metadata.
 * - Verify DNS records for the configured domain using real DNS lookups.
 * - Manage mail server status and configuration (placeholder for Docker API).
 * - Create mailbox accounts (placeholder for docker-mailserver CLI).
 * - Send test emails using the configured SMTP transport.
 * - Save custom SMTP configuration for app email sending.
 *
 * Dependencies:
 * - `@/auth` for session verification.
 * - `@/db`, `@/db/schema` for metadata persistence.
 * - `dns/promises` for real DNS resolution.
 * - `@/lib/email` for test email delivery.
 * - `@/lib/rate-limit` for abuse prevention.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { resolve, resolveMx, resolveTxt } from "dns/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_EMAIL_LENGTH = 255;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_DOMAIN_LENGTH = 255;
const MAX_SMTP_HOST_LENGTH = 255;
const MAX_SMTP_PORT = 65535;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$/;

/** Metadata key where personal email config is stored. */
const PERSONAL_EMAIL_KEY = "personalEmail";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ActionResult<T = void> = {
  success: boolean;
  error?: string;
  data?: T;
};

export type EmailIdentityData = {
  emailAddress: string;
  displayName: string;
  domain: string;
};

export type DnsRecordStatus = {
  type: string;
  name: string;
  expectedValue: string;
  verified: boolean;
  actualValue?: string;
  note?: string;
};

export type DnsVerificationResult = {
  domain: string;
  records: DnsRecordStatus[];
  allVerified: boolean;
};

export type MailServerStatus = {
  state: "running" | "stopped" | "not_installed" | "unknown";
  containerName?: string;
  mailboxCreated: boolean;
  domain?: string;
};

export type SmtpConfigData = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpSecure: boolean;
  usePersonalMailServer: boolean;
};

export type PersonalEmailConfig = {
  emailAddress?: string;
  displayName?: string;
  domain?: string;
  serverIp?: string;
  mailServerState?: string;
  mailboxCreated?: boolean;
  smtpConfig?: Partial<SmtpConfigData>;
  setupCompletedAt?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getAuthenticatedUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

async function getUserMetadata(userId: string): Promise<Record<string, unknown>> {
  const [user] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  if (!user) return {};

  return user.metadata && typeof user.metadata === "object"
    ? (user.metadata as Record<string, unknown>)
    : {};
}

async function updateUserMetadata(
  userId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await db.execute(sql`
    UPDATE agents
    SET metadata = ${JSON.stringify(metadata)}::jsonb, updated_at = NOW()
    WHERE id = ${userId}
  `);
}

function getPersonalEmailConfig(metadata: Record<string, unknown>): PersonalEmailConfig {
  const raw = metadata[PERSONAL_EMAIL_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as PersonalEmailConfig;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Saves the user's email identity (address, display name, domain).
 * Stores in user metadata under the `personalEmail` key.
 */
export async function saveEmailIdentityAction(
  data: EmailIdentityData
): Promise<ActionResult> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const check = await rateLimit(
    `personal-email:${userId}`,
    RATE_LIMITS.SETTINGS.limit,
    RATE_LIMITS.SETTINGS.windowMs
  );
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  const emailAddress = data.emailAddress?.trim().toLowerCase() ?? "";
  const displayName = data.displayName?.trim() ?? "";
  const domain = data.domain?.trim().toLowerCase() ?? "";

  if (!emailAddress || !EMAIL_RE.test(emailAddress)) {
    return { success: false, error: "Please enter a valid email address." };
  }
  if (emailAddress.length > MAX_EMAIL_LENGTH) {
    return { success: false, error: `Email must be ${MAX_EMAIL_LENGTH} characters or fewer.` };
  }

  if (!displayName) {
    return { success: false, error: "Display name is required." };
  }
  if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return { success: false, error: `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.` };
  }

  if (!domain || !DOMAIN_RE.test(domain)) {
    return { success: false, error: "Please enter a valid domain." };
  }
  if (domain.length > MAX_DOMAIN_LENGTH) {
    return { success: false, error: `Domain must be ${MAX_DOMAIN_LENGTH} characters or fewer.` };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const existing = getPersonalEmailConfig(metadata);

    const updated: PersonalEmailConfig = {
      ...existing,
      emailAddress,
      displayName,
      domain,
    };

    metadata[PERSONAL_EMAIL_KEY] = updated;
    await updateUserMetadata(userId, metadata);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to save identity: ${message}`);
    return { success: false, error: "Unable to save email identity." };
  }
}

/**
 * Verifies DNS records for the given domain using real DNS lookups.
 * Checks MX, A (mail subdomain), SPF, and DMARC records.
 */
export async function verifyDnsRecordsAction(
  domain: string
): Promise<ActionResult<DnsVerificationResult>> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const cleanDomain = domain?.trim().toLowerCase() ?? "";
  if (!cleanDomain || !DOMAIN_RE.test(cleanDomain)) {
    return { success: false, error: "Please provide a valid domain." };
  }

  // Read server IP from user's stored config or fall back to env
  const metadata = await getUserMetadata(userId);
  const config = getPersonalEmailConfig(metadata);
  const serverIp = config.serverIp || process.env.MAIL_SERVER_IP || process.env.HOST_IP || "";

  const records: DnsRecordStatus[] = [];

  // Check MX record
  try {
    const mxRecords = await resolveMx(cleanDomain);
    const hasMx = mxRecords.some(
      (mx) =>
        mx.exchange.toLowerCase() === `mail.${cleanDomain}` ||
        mx.exchange.toLowerCase() === `mail.${cleanDomain}.`
    );
    records.push({
      type: "MX",
      name: `${cleanDomain}`,
      expectedValue: `10 mail.${cleanDomain}`,
      verified: hasMx,
      actualValue: mxRecords.map((mx) => `${mx.priority} ${mx.exchange}`).join(", ") || "none",
    });
  } catch {
    records.push({
      type: "MX",
      name: `${cleanDomain}`,
      expectedValue: `10 mail.${cleanDomain}`,
      verified: false,
      actualValue: "not found",
      note: "No MX records found for this domain.",
    });
  }

  // Check A record for mail subdomain
  try {
    const aRecords = await resolve(`mail.${cleanDomain}`, "A");
    const hasA = serverIp ? aRecords.includes(serverIp) : aRecords.length > 0;
    records.push({
      type: "A",
      name: `mail.${cleanDomain}`,
      expectedValue: serverIp || "<your server IP>",
      verified: hasA,
      actualValue: aRecords.join(", ") || "none",
      note: !serverIp ? "Set your server IP in mail server settings to verify this record." : undefined,
    });
  } catch {
    records.push({
      type: "A",
      name: `mail.${cleanDomain}`,
      expectedValue: serverIp || "<your server IP>",
      verified: false,
      actualValue: "not found",
      note: "No A record found for the mail subdomain.",
    });
  }

  // Check SPF record
  try {
    const txtRecords = await resolveTxt(cleanDomain);
    const flatTxt = txtRecords.map((arr) => arr.join(""));
    const spfRecord = flatTxt.find((txt) => txt.startsWith("v=spf1"));
    const expectedSpf = serverIp
      ? `v=spf1 ip4:${serverIp} ~all`
      : "v=spf1 ... ~all";
    const hasSpf = spfRecord
      ? serverIp
        ? spfRecord.includes(`ip4:${serverIp}`)
        : spfRecord.startsWith("v=spf1")
      : false;
    records.push({
      type: "TXT (SPF)",
      name: `${cleanDomain}`,
      expectedValue: expectedSpf,
      verified: hasSpf,
      actualValue: spfRecord || "not found",
    });
  } catch {
    records.push({
      type: "TXT (SPF)",
      name: `${cleanDomain}`,
      expectedValue: serverIp ? `v=spf1 ip4:${serverIp} ~all` : "v=spf1 ... ~all",
      verified: false,
      actualValue: "not found",
    });
  }

  // Check DKIM — this is generated by the mail server, so we just check if it exists
  try {
    const dkimRecords = await resolveTxt(`mail._domainkey.${cleanDomain}`);
    const flatDkim = dkimRecords.map((arr) => arr.join(""));
    const hasDkim = flatDkim.some((txt) => txt.includes("v=DKIM1"));
    records.push({
      type: "TXT (DKIM)",
      name: `mail._domainkey.${cleanDomain}`,
      expectedValue: "v=DKIM1; k=rsa; p=<generated after mail server setup>",
      verified: hasDkim,
      actualValue: hasDkim ? flatDkim.find((t) => t.includes("v=DKIM1"))?.substring(0, 80) + "..." : "not found",
      note: hasDkim ? undefined : "DKIM key will be generated when the mail server is set up.",
    });
  } catch {
    records.push({
      type: "TXT (DKIM)",
      name: `mail._domainkey.${cleanDomain}`,
      expectedValue: "v=DKIM1; k=rsa; p=<generated after mail server setup>",
      verified: false,
      actualValue: "not found",
      note: "DKIM key will be generated when the mail server is set up.",
    });
  }

  // Check DMARC record
  try {
    const dmarcRecords = await resolveTxt(`_dmarc.${cleanDomain}`);
    const flatDmarc = dmarcRecords.map((arr) => arr.join(""));
    const hasDmarc = flatDmarc.some((txt) => txt.startsWith("v=DMARC1"));
    records.push({
      type: "TXT (DMARC)",
      name: `_dmarc.${cleanDomain}`,
      expectedValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${cleanDomain}`,
      verified: hasDmarc,
      actualValue: flatDmarc.find((t) => t.startsWith("v=DMARC1")) || "not found",
    });
  } catch {
    records.push({
      type: "TXT (DMARC)",
      name: `_dmarc.${cleanDomain}`,
      expectedValue: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${cleanDomain}`,
      verified: false,
      actualValue: "not found",
    });
  }

  // PTR record note (cannot be verified from this side easily)
  records.push({
    type: "PTR",
    name: serverIp || "<your server IP>",
    expectedValue: `mail.${cleanDomain}`,
    verified: false,
    note: "PTR records must be set in your hosting provider's control panel (reverse DNS). Cannot be verified from here.",
  });

  const allVerified = records
    .filter((r) => r.type !== "PTR" && !r.note?.includes("generated"))
    .every((r) => r.verified);

  return {
    success: true,
    data: {
      domain: cleanDomain,
      records,
      allVerified,
    },
  };
}

/**
 * Gets the current mail server status.
 * Currently reads from stored config. Docker API integration is a future step.
 */
export async function getMailServerStatusAction(): Promise<ActionResult<MailServerStatus>> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const config = getPersonalEmailConfig(metadata);

    const state = (config.mailServerState as MailServerStatus["state"]) || "not_installed";

    return {
      success: true,
      data: {
        state,
        containerName: "docker-mailserver",
        mailboxCreated: config.mailboxCreated ?? false,
        domain: config.domain,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to get mail server status: ${message}`);
    return { success: false, error: "Unable to check mail server status." };
  }
}

/**
 * Triggers mail server setup. Currently stores configuration.
 * TODO: Wire to Docker API to actually deploy docker-mailserver container.
 */
export async function setupMailServerAction(
  domain: string,
  email: string,
  serverIp?: string
): Promise<ActionResult> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const check = await rateLimit(
    `mail-setup:${userId}`,
    RATE_LIMITS.SETTINGS.limit,
    RATE_LIMITS.SETTINGS.windowMs
  );
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  const cleanDomain = domain?.trim().toLowerCase() ?? "";
  const cleanEmail = email?.trim().toLowerCase() ?? "";

  if (!cleanDomain || !DOMAIN_RE.test(cleanDomain)) {
    return { success: false, error: "Please provide a valid domain." };
  }
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
    return { success: false, error: "Please provide a valid email address." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const existing = getPersonalEmailConfig(metadata);

    // TODO: Invoke Docker API to create/start docker-mailserver container
    // For now, store the configuration and mark as "stopped" (config saved, not yet running)
    const updated: PersonalEmailConfig = {
      ...existing,
      domain: cleanDomain,
      emailAddress: cleanEmail,
      serverIp: serverIp?.trim() || existing.serverIp,
      mailServerState: "stopped",
    };

    metadata[PERSONAL_EMAIL_KEY] = updated;
    await updateUserMetadata(userId, metadata);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to setup mail server: ${message}`);
    return { success: false, error: "Unable to set up mail server." };
  }
}

/**
 * Stops the mail server.
 * TODO: Wire to Docker API to stop docker-mailserver container.
 */
export async function stopMailServerAction(): Promise<ActionResult> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const existing = getPersonalEmailConfig(metadata);

    // TODO: Invoke Docker API to stop docker-mailserver container
    const updated: PersonalEmailConfig = {
      ...existing,
      mailServerState: "stopped",
    };

    metadata[PERSONAL_EMAIL_KEY] = updated;
    await updateUserMetadata(userId, metadata);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to stop mail server: ${message}`);
    return { success: false, error: "Unable to stop mail server." };
  }
}

/**
 * Creates a mailbox account on the mail server.
 * TODO: Wire to docker-mailserver CLI (`setup email add`) for actual mailbox creation.
 */
export async function createMailboxAction(
  email: string,
  password: string
): Promise<ActionResult> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const check = await rateLimit(
    `mailbox-create:${userId}`,
    RATE_LIMITS.SETTINGS.limit,
    RATE_LIMITS.SETTINGS.windowMs
  );
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  const cleanEmail = email?.trim().toLowerCase() ?? "";
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
    return { success: false, error: "Please provide a valid email address." };
  }
  if (!password || password.length < 8) {
    return { success: false, error: "Password must be at least 8 characters." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const existing = getPersonalEmailConfig(metadata);

    // TODO: Invoke docker-mailserver CLI:
    // docker exec docker-mailserver setup email add <email> <password>
    const updated: PersonalEmailConfig = {
      ...existing,
      mailboxCreated: true,
      emailAddress: cleanEmail,
    };

    metadata[PERSONAL_EMAIL_KEY] = updated;
    await updateUserMetadata(userId, metadata);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to create mailbox: ${message}`);
    return { success: false, error: "Unable to create mailbox." };
  }
}

/**
 * Sends a test email using the existing SMTP transport to verify outbound delivery.
 */
export async function sendTestEmailAction(
  toAddress: string
): Promise<ActionResult<{ messageId?: string }>> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const check = await rateLimit(
    `test-email:${userId}`,
    RATE_LIMITS.SETTINGS.limit,
    RATE_LIMITS.SETTINGS.windowMs
  );
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  const cleanTo = toAddress?.trim().toLowerCase() ?? "";
  if (!cleanTo || !EMAIL_RE.test(cleanTo)) {
    return { success: false, error: "Please provide a valid recipient email address." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const config = getPersonalEmailConfig(metadata);

    const result = await sendEmail({
      to: cleanTo,
      subject: "Test Email from Personal Mail Server",
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Test Email</h2>
          <p>This is a test email sent from your personal email server configuration.</p>
          <p><strong>Domain:</strong> ${config.domain || "not configured"}</p>
          <p><strong>Email Address:</strong> ${config.emailAddress || "not configured"}</p>
          <hr style="border: 1px solid #eee;" />
          <p style="color: #999; font-size: 12px;">
            Sent via Rivr Personal Email at ${new Date().toISOString()}
          </p>
        </div>
      `,
      text: `Test Email\n\nThis is a test email sent from your personal email server configuration.\nDomain: ${config.domain || "not configured"}\nEmail: ${config.emailAddress || "not configured"}\n\nSent at ${new Date().toISOString()}`,
    });

    if (result.success) {
      return { success: true, data: { messageId: result.messageId } };
    }

    return { success: false, error: result.error || "Failed to send test email." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to send test email: ${message}`);
    return { success: false, error: "Unable to send test email." };
  }
}

/**
 * Saves SMTP configuration for app email sending.
 */
export async function saveSmtpConfigAction(
  data: Partial<SmtpConfigData>
): Promise<ActionResult> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  const check = await rateLimit(
    `smtp-config:${userId}`,
    RATE_LIMITS.SETTINGS.limit,
    RATE_LIMITS.SETTINGS.windowMs
  );
  if (!check.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  if (data.smtpHost && data.smtpHost.length > MAX_SMTP_HOST_LENGTH) {
    return { success: false, error: `SMTP host must be ${MAX_SMTP_HOST_LENGTH} characters or fewer.` };
  }
  if (data.smtpPort !== undefined && (data.smtpPort < 1 || data.smtpPort > MAX_SMTP_PORT)) {
    return { success: false, error: `SMTP port must be between 1 and ${MAX_SMTP_PORT}.` };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const existing = getPersonalEmailConfig(metadata);

    const updated: PersonalEmailConfig = {
      ...existing,
      smtpConfig: {
        ...existing.smtpConfig,
        ...data,
      },
    };

    metadata[PERSONAL_EMAIL_KEY] = updated;
    await updateUserMetadata(userId, metadata);

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to save SMTP config: ${message}`);
    return { success: false, error: "Unable to save SMTP configuration." };
  }
}

/**
 * Loads the current personal email configuration from user metadata.
 */
export async function getPersonalEmailConfigAction(): Promise<ActionResult<PersonalEmailConfig>> {
  const userId = await getAuthenticatedUserId();
  if (!userId) {
    return { success: false, error: "Authentication required." };
  }

  try {
    const metadata = await getUserMetadata(userId);
    const config = getPersonalEmailConfig(metadata);

    return { success: true, data: config };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[personal-email] Failed to load config: ${message}`);
    return { success: false, error: "Unable to load email configuration." };
  }
}
