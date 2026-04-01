import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getProvenanceLog } from "@/lib/federation/mcp-provenance";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const toolName = url.searchParams.get("toolName") ?? undefined;
  const actorType = url.searchParams.get("actorType") as
    | "human"
    | "persona"
    | "autobot"
    | undefined;
  const resultStatus = url.searchParams.get("resultStatus") as
    | "success"
    | "error"
    | undefined;
  const limit = url.searchParams.has("limit")
    ? Number(url.searchParams.get("limit"))
    : undefined;

  const entries = await getProvenanceLog({
    toolName,
    actorType,
    resultStatus,
    limit,
  });

  return NextResponse.json({ entries, count: entries.length });
}
