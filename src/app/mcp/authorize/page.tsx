/**
 * /mcp/authorize — human-facing MCP device code authorization page.
 *
 * When a CLI or agent requests a device code, it tells the user to visit
 * this URL with their user_code. The page shows the code details and
 * lets the user approve or deny. After login redirect, the user_code
 * query param is preserved.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { DeviceAuthorizeClient } from "./client";

interface PageProps {
  searchParams: Promise<{ user_code?: string | string[] }>;
}

export default async function DeviceAuthorizePage({ searchParams }: PageProps) {
  const raw = await searchParams;
  const rawCode = Array.isArray(raw.user_code) ? raw.user_code[0] : raw.user_code;
  const userCode = rawCode?.trim().toUpperCase() ?? "";
  const session = await auth();
  const config = getInstanceConfig();

  if (!session?.user?.id) {
    const here = `/mcp/authorize${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ""}`;
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(here)}`);
  }

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Authorize MCP Access</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Signed in as{" "}
          <span className="font-medium text-foreground">
            {session.user.name ?? session.user.email ?? "you"}
          </span>{" "}
          on {new URL(config.baseUrl).hostname}.
        </p>

        <DeviceAuthorizeClient userCode={userCode} />
      </div>
    </div>
  );
}
