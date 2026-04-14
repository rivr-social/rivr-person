import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getTellerClientConfig,
  listLinkedTellerBankAccounts,
} from "@/lib/teller";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = getTellerClientConfig();

  try {
    const linkedAccounts = config.apiConfigured
      ? await listLinkedTellerBankAccounts(session.user.id)
      : [];

    return NextResponse.json({
      ...config,
      linkedAccounts,
    });
  } catch (error) {
    console.error("[wallet][banks] Failed to load Teller accounts:", error);
    return NextResponse.json(
      {
        ...config,
        linkedAccounts: [],
        error:
          error instanceof Error
            ? error.message
            : "Unable to load linked bank accounts.",
      },
      { status: 500 },
    );
  }
}
