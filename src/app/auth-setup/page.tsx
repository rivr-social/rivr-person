import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { AuthSetupClient } from "./client";

export const dynamic = "force-dynamic";

export default async function AuthSetupPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/auth/login");
  return <AuthSetupClient />;
}
