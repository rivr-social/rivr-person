import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SessionRecordPage } from "@/components/session-record-page";

export default async function SessionRecordRoute() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/auth/login");
  }

  return <SessionRecordPage />;
}
