import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { createTellerConnectNonce, getTellerClientConfig } from "@/lib/teller";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = getTellerClientConfig();
  if (!config.connectConfigured) {
    return NextResponse.json(
      { error: "Teller Connect is not configured on this instance." },
      { status: 503 },
    );
  }

  const nonce = createTellerConnectNonce();
  const response = NextResponse.json({
    applicationId: config.applicationId,
    environment: config.environment,
    products: config.products,
    apiConfigured: config.apiConfigured,
    nonce,
  });

  response.cookies.set("teller_connect_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/wallet/banks",
  });

  return response;
}
