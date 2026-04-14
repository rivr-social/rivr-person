import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  handleTellerWebhookEvent,
  verifyTellerWebhookSignature,
  type TellerWebhookEvent,
} from "@/lib/teller";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get("Teller-Signature");

  try {
    verifyTellerWebhookSignature({
      rawBody,
      signatureHeader,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid Teller webhook signature.",
      },
      { status: 400 },
    );
  }

  let event: TellerWebhookEvent;
  try {
    event = JSON.parse(rawBody) as TellerWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  try {
    const result = await handleTellerWebhookEvent(event);
    return NextResponse.json({
      received: true,
      type: event.type,
      affectedUsers: result.affectedUsers,
    });
  } catch (error) {
    console.error("[wallet][teller][webhook] Failed to handle event:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to process Teller webhook.",
      },
      { status: 500 },
    );
  }
}
