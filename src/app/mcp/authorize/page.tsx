/**
 * /mcp/authorize — human-facing MCP authorization landing page.
 *
 * rivr-person does not yet ship the full RFC 8628 device-code tables and
 * polling endpoints. This page still handles the browser/login round-trip
 * itself so incoming `user_code` values are not stripped by middleware.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";

interface PageProps {
  searchParams: Promise<{ user_code?: string | string[] }>;
}

export default async function DeviceAuthorizePage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const rawCode = Array.isArray(raw.user_code) ? raw.user_code[0] : raw.user_code;
  const userCode = rawCode?.trim() ?? "";
  const session = await auth();
  const config = getInstanceConfig();

  if (!session?.user?.id) {
    const here = `/mcp/authorize${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`;
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(here)}`);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Authorize MCP access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">
            {session.user.name ?? session.user.email ?? "you"}
          </span>{" "}
          on {new URL(config.baseUrl).hostname}.
        </p>

        {userCode ? (
          <p className="mt-4 text-sm">
            Request code{" "}
            <code className="rounded bg-muted px-1 font-mono">{userCode}</code>{" "}
            was preserved through login.
          </p>
        ) : (
          <p className="mt-4 text-sm">
            No request code was provided. Your CLI should send you here with a
            code like <code className="rounded bg-muted px-1 font-mono">WDJB-MJHT</code>.
          </p>
        )}

        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
          Device-code approval is not enabled on this sovereign instance yet.
          Use the scoped token page until the schema-backed device flow is
          ported.
        </div>

        <div className="mt-6 flex gap-3 text-sm">
          <Link href="/api/mcp/token" className="underline hover:text-foreground">
            Get scoped token
          </Link>
          <Link href="/settings" className="underline hover:text-foreground">
            Settings
          </Link>
        </div>
      </div>
    </div>
  );
}
