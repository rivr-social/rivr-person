import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import {
  runConnectorSync,
  ConnectorSyncError,
  CONNECTOR_SYNC_FAILURE,
} from "@/lib/autobot-connector-sync";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

export async function POST(_request: Request, context: RouteContext) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  if (!ownerId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subject = await resolveAutobotConnectionScope(ownerId);
  const actorId = subject.actorId;

  const { provider } = await context.params;

  try {
    const { result, kgIngest, connections } = await runConnectorSync(
      actorId,
      provider,
    );

    return NextResponse.json({
      result,
      kgIngest,
      connections,
      subject,
    });
  } catch (error) {
    if (error instanceof ConnectorSyncError) {
      if (error.code === CONNECTOR_SYNC_FAILURE.NOT_CONFIGURED) {
        return NextResponse.json(
          { error: "Connector is not configured" },
          { status: 404 },
        );
      }
      if (
        error.code === CONNECTOR_SYNC_FAILURE.UNKNOWN_PROVIDER ||
        error.code === CONNECTOR_SYNC_FAILURE.SYNC_UNSUPPORTED
      ) {
        return NextResponse.json(
          { error: "Sync is not implemented for this connector yet" },
          { status: 400 },
        );
      }
      // SYNC_FAILED — the lane threw; connection state already persisted as error.
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const message =
      error instanceof Error ? error.message : "Connector sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
