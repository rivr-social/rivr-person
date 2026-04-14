import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  listLinkedTellerBankAccounts,
  saveTellerEnrollment,
  verifyTellerEnrollmentSignature,
} from "@/lib/teller";

export const dynamic = "force-dynamic";

type EnrollmentBody = {
  accessToken?: string;
  user?: { id?: string | null };
  enrollment?: {
    id?: string | null;
    institution?: { name?: string | null };
  };
  signatures?: string[];
};

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: EnrollmentBody;
  try {
    body = (await request.json()) as EnrollmentBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const accessToken = body.accessToken?.trim();
  const tellerUserId = body.user?.id?.trim();
  const enrollmentId = body.enrollment?.id?.trim();
  const institutionName = body.enrollment?.institution?.name?.trim() ?? null;
  const signatures = Array.isArray(body.signatures)
    ? body.signatures.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  if (!accessToken || !tellerUserId || !enrollmentId) {
    return NextResponse.json(
      { error: "Missing Teller enrollment payload." },
      { status: 400 },
    );
  }

  const nonceCookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("teller_connect_nonce="))
    ?.split("=")[1];

  if (!nonceCookie) {
    return NextResponse.json(
      { error: "Missing Teller session nonce." },
      { status: 400 },
    );
  }

  if (
    signatures.length > 0 &&
    !verifyTellerEnrollmentSignature({
      nonce: nonceCookie,
      accessToken,
      tellerUserId,
      enrollmentId,
      signatures,
    })
  ) {
    return NextResponse.json(
      { error: "Unable to verify Teller enrollment signature." },
      { status: 400 },
    );
  }

  await saveTellerEnrollment({
    userId: session.user.id,
    enrollmentId,
    accessToken,
    tellerUserId,
    institutionName,
  });

  const linkedAccounts = await listLinkedTellerBankAccounts(session.user.id);
  const response = NextResponse.json({ success: true, linkedAccounts });
  response.cookies.set("teller_connect_nonce", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/wallet/banks",
  });
  return response;
}
