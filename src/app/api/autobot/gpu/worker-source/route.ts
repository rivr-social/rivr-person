/**
 * GET /api/autobot/gpu/worker-source
 *
 * Serves the Chatterbox worker's python source. The Vast instance's
 * onstart script curls this at boot — RIVR ships no images through
 * registries, and this keeps the worker code single-sourced in the repo.
 * Public: it is source code with no secrets (auth token arrives via env).
 */

import { CHATTERBOX_WORKER_SOURCE } from "@/lib/chatterbox/worker-source";

export const dynamic = "force-static";

export async function GET() {
  return new Response(CHATTERBOX_WORKER_SOURCE, {
    status: 200,
    headers: {
      "Content-Type": "text/x-python; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
