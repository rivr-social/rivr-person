import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { initiateTellerPayment, type TellerPaymentInput } from "@/lib/teller";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: TellerPaymentInput;
  try {
    body = (await request.json()) as TellerPaymentInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.sourceAccountId?.trim() || !body.amount?.trim() || !body.payeeAddress?.trim()) {
    return NextResponse.json(
      { error: "Source account, amount, and payee address are required." },
      { status: 400 },
    );
  }

  try {
    const payment = await initiateTellerPayment(session.user.id, body);
    return NextResponse.json({ payment });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to initiate transfer.",
      },
      { status: 500 },
    );
  }
}
