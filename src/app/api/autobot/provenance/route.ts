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
  const actorId = url.searchParams.get("actorId") ?? undefined;
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

  const startDateRaw = url.searchParams.get("startDate");
  const endDateRaw = url.searchParams.get("endDate");
  const startDate = startDateRaw ? new Date(startDateRaw) : undefined;
  const endDate = endDateRaw ? new Date(endDateRaw) : undefined;

  const entries = await getProvenanceLog({
    toolName,
    actorId,
    actorType,
    resultStatus,
    startDate,
    endDate,
    limit,
  });

  // Collect distinct tool names for the filter dropdown when no toolName filter
  // is active. This avoids a separate endpoint.
  const distinctToolNames = Array.from(
    new Set(entries.map((e) => e.toolName))
  ).sort();

  return NextResponse.json({
    entries,
    count: entries.length,
    distinctToolNames,
  });
}
