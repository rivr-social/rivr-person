import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { verify } from "@node-rs/bcrypt";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72;

type VerifyPasswordRequest = {
  email?: string;
  password?: string;
};

function invalid() {
  return NextResponse.json({ success: false }, { status: 401 });
}

export async function POST(request: Request) {
  let body: VerifyPasswordRequest;
  try {
    body = (await request.json()) as VerifyPasswordRequest;
  } catch {
    return invalid();
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (
    !email ||
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    return invalid();
  }

  const limiter = await rateLimit(
    `federation-remote-password:${email}`,
    RATE_LIMITS.AUTH.limit,
    RATE_LIMITS.AUTH.windowMs,
  );
  if (!limiter.success) {
    return NextResponse.json({ success: false }, { status: 429 });
  }

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      image: agents.image,
      passwordHash: agents.passwordHash,
    })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);

  if (!agent?.passwordHash) {
    return invalid();
  }

  const passwordValid = await verify(password, agent.passwordHash);
  if (!passwordValid) {
    return invalid();
  }

  return NextResponse.json({
    success: true,
    actor: {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      image: agent.image,
    },
  });
}
