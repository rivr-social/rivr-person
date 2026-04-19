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

  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        {/* Fixed water background for light mode — glass distortion refracts against this */}
        <div id="rivr-water-bg" />
        {/* SVG filters for liquid glass effect — hidden, referenced by CSS url() */}
        <svg style={{ display: "none" }} aria-hidden="true">
          <filter id="glass-distortion-shell" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
            <feTurbulence type="fractalNoise" baseFrequency="0.01 0.01" numOctaves={1} seed={5} result="turbulence" />
            <feComponentTransfer in="turbulence" result="mapped">
              <feFuncR type="gamma" amplitude={1} exponent={10} offset={0.5} />
              <feFuncG type="gamma" amplitude={0} exponent={1} offset={0} />
              <feFuncB type="gamma" amplitude={0} exponent={1} offset={0.5} />
            </feComponentTransfer>
            <feGaussianBlur in="turbulence" stdDeviation={2} result="softMap" />
            <feSpecularLighting in="softMap" surfaceScale={4} specularConstant={0.9} specularExponent={80} lightingColor="white" result="specLight">
              <fePointLight x={-200} y={-200} z={300} />
            </feSpecularLighting>
            <feComposite in="specLight" operator="arithmetic" k1={0} k2={1} k3={1} k4={0} result="litImage" />
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={36} xChannelSelector="R" yChannelSelector="G" />
          </filter>
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
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={150} xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="glass-distortion-strong" x="0%" y="0%" width="100%" height="100%" filterUnits="objectBoundingBox">
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
            <feDisplacementMap in="SourceGraphic" in2="softMap" scale={80} xChannelSelector="R" yChannelSelector="G" />
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
                <Toaster />
              </AppProvider>
            </UserProvider>
          </ThemeProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
