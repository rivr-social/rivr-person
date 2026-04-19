import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { listDbEntries } from "@/lib/agent-hq-db-explorer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await assertAgentHqAccess();
    const url = new URL(request.url);
    const path = url.searchParams.get("path") ?? "";
    const result = await listDbEntries(path);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list database entries";
    const status = message === "Authentication required" ? 401 : 403;
    return NextResponse.json({ error: message }, { status });
  }
}
