import { handleConnectorOAuthConnect } from "@/lib/autobot-oauth-route";

export const dynamic = "force-dynamic";

export async function GET() {
  return handleConnectorOAuthConnect("discord");
}
