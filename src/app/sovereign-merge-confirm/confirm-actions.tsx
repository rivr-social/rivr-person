"use client";

/**
 * Client-side approve / cancel buttons for the sovereign merge confirm page.
 *
 * Approve calls the `approveSovereignMergeAction` server action; on success
 * the popup is navigated to the global callback URL. The global callback
 * page then posts a message to `window.opener` and closes itself.
 *
 * Cancel attempts `window.close()` so the user lands back on global with no
 * link applied. If the popup cannot self-close (browser policy), we fall
 * back to a "you can close this window" notice so the user is never stuck.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { approveSovereignMergeAction } from "@/app/actions/sovereign-merge-approve";

export function SovereignMergeConfirmActions(props: {
  mergeRequestId: string;
  globalUrl: string;
  globalAgentId: string;
  callbackUrl: string;
  token: string;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  async function handleApprove() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await approveSovereignMergeAction({
        mergeRequestId: props.mergeRequestId,
        globalUrl: props.globalUrl,
        globalAgentId: props.globalAgentId,
        callbackUrl: props.callbackUrl,
        token: props.token,
      });
      if (!result.ok) {
        setError(result.error);
        setSubmitting(false);
        return;
      }
      // Hard navigation: the popup must hit the global origin so the global
      // callback can read its session cookie + run the merge handlers.
      window.location.href = result.redirectUrl;
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to approve sovereign merge.",
      );
      setSubmitting(false);
    }
  }

  function handleCancel() {
    try {
      window.close();
    } catch {
      // ignore — we handle below
    }
    // If the browser refused to close (popup not opened by script that owns
    // it), at least let the user know it's safe to close manually.
    setClosed(true);
  }

  if (closed) {
    return (
      <div className="rounded-md border p-3 text-sm text-muted-foreground">
        Sovereign link cancelled. You can close this window.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" onClick={handleApprove} disabled={submitting}>
          {submitting ? "Approving..." : "Approve"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleCancel}
          disabled={submitting}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
