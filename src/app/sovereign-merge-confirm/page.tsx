/**
 * Sovereign-merge confirmation page.
 *
 * The global Rivr app opens this page in a popup against the sovereign side
 * after the user typed in `https://yourname.rivr.social` on global. We:
 *
 * 1. Server-render the request summary so the user sees exactly which global
 *    instance is asking, and decoded query params can't be tampered with at
 *    render time.
 * 2. Require the user to be signed in to this sovereign — if not, redirect
 *    to the sovereign login with a `callbackUrl` that returns here.
 * 3. Hand the merge parameters to a small client component that calls the
 *    `approveSovereignMergeAction` server action and navigates the popup to
 *    the global callback URL on success.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SovereignMergeConfirmActions } from "./confirm-actions";

type SearchParams = {
  merge_request_id?: string;
  global_url?: string;
  global_agent_id?: string;
  callback_url?: string;
  token?: string;
};

export default async function SovereignMergeConfirmPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const mergeRequestId = (params.merge_request_id ?? "").trim();
  const globalUrl = (params.global_url ?? "").trim();
  const globalAgentId = (params.global_agent_id ?? "").trim();
  const callbackUrl = (params.callback_url ?? "").trim();
  const token = (params.token ?? "").trim();

  // Build the callback path on this same sovereign so the user can finish
  // confirming after login. We rebuild the full query string verbatim so
  // none of the merge parameters are lost across the auth bounce.
  const selfPath = `/sovereign-merge-confirm?merge_request_id=${encodeURIComponent(mergeRequestId)}&global_url=${encodeURIComponent(globalUrl)}&global_agent_id=${encodeURIComponent(globalAgentId)}&callback_url=${encodeURIComponent(callbackUrl)}&token=${encodeURIComponent(token)}`;

  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/auth/login?callbackUrl=${encodeURIComponent(selfPath)}`);
  }

  if (
    !mergeRequestId ||
    !globalUrl ||
    !globalAgentId ||
    !callbackUrl ||
    !token
  ) {
    return (
      <main className="mx-auto max-w-xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Sovereign Link Request</CardTitle>
            <CardDescription>
              This merge request is missing required parameters. Close this
              window and try again from the global app.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  // Render the human-readable host names so users can sanity-check the merge
  // before approving. We never trust these for security — the global side
  // verifies the token signature.
  let globalHost = globalUrl;
  try {
    globalHost = new URL(globalUrl).host;
  } catch {
    // fall through with raw string
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <Card>
        <CardHeader>
          <CardTitle>Sovereign Link Request</CardTitle>
          <CardDescription>
            Allow <span className="font-mono">{globalHost}</span> to link this
            sovereign account as canonical for your Rivr content? After
            linking, your global content will be migrated to this sovereign
            instance and your global account will keep identity authority
            (login, password reset).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Global account
            </p>
            <p className="mt-1 break-all font-mono">{globalAgentId}</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Sovereign account (this instance)
            </p>
            <p className="mt-1 break-all font-mono">{session.user.id}</p>
          </div>
          <SovereignMergeConfirmActions
            mergeRequestId={mergeRequestId}
            globalUrl={globalUrl}
            globalAgentId={globalAgentId}
            callbackUrl={callbackUrl}
            token={token}
          />
        </CardContent>
      </Card>
    </main>
  );
}
