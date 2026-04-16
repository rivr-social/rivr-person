import type { Metadata } from "next";

// All pages are dynamic — they depend on the database and user session.
export const dynamic = "force-dynamic";
import { ThemeProvider } from "@/components/theme-provider";
import { SessionProvider } from "@/components/session-provider";
import { AuthGuard } from "@/components/auth-guard";
import { Toaster } from "sonner";
import { GlobalHeader } from "@/components/global-header";
import { PersonaBanner } from "@/components/persona-banner";
import { AppProvider } from "@/contexts/app-context";
import { UserProvider } from "@/contexts/user-context";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { ExecutiveLauncherHost } from "@/components/executive-launcher-host";
import { getGroupsForUser } from "@/lib/queries/agents";
import { and, eq, isNull } from "drizzle-orm";
import "@xterm/xterm/css/xterm.css";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'),
  title: "RIVR",
  description: "Social coordination platform for communities",
  icons: {
    icon: '/rivr-emoji.png',
    shortcut: '/rivr-emoji.png',
    apple: '/rivr-emoji.png',
  }
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  const [personaRows, groupRows] = ownerId
    ? await Promise.all([
        db
          .select({
            id: agents.id,
            name: agents.name,
          })
          .from(agents)
          .where(and(eq(agents.parentAgentId, ownerId), isNull(agents.deletedAt)))
          .orderBy(agents.createdAt),
        getGroupsForUser(ownerId, 100),
      ])
    : [[], []];
  const personas = personaRows.map((persona) => ({
    id: persona.id,
    label: persona.name?.trim() || "Persona",
  }));
  const groups = groupRows.map((group) => ({
    id: group.id,
    label: group.name?.trim() || "Group",
  }));

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background" suppressHydrationWarning>
        {/* SVG displacement filter for liquid glass effect */}
        <svg style={{ display: "none" }} aria-hidden="true">
          <filter id="glass-distortion" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
              <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
              <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation={3} result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale={5} specularConstant={1} specularExponent={100} lightingColor="white" result="specLight">
              <fePointLight x={-200} y={-200} z={300} />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={30} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        <SessionProvider session={session}>
          <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
            <UserProvider>
              <AppProvider>
                <GlobalHeader />
                <PersonaBanner />
                <AuthGuard>
                  <main className="pt-16 pb-16 md:pb-0">{children}</main>
                </AuthGuard>
                {ownerId ? <ExecutiveLauncherHost personas={personas} groups={groups} /> : null}
                <Toaster />
              </AppProvider>
            </UserProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
