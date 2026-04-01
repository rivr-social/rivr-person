// app/(main)/layout.tsx
"use client";

import type React from "react";
import { useState } from "react";
import { Slash } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import { CommandBar } from "@/components/CommandBar";
import { usePathname } from "next/navigation";

export default function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [commandBarVisible, setCommandBarVisible] = useState(false);
  const pathname = usePathname();
  const hideGlobalCommandLauncher = pathname.startsWith("/builder");

  return (
    <div className="min-h-screen pb-16">
      {children}
      {!hideGlobalCommandLauncher ? (
        <>
          <div className="fixed bottom-20 left-0 right-0 z-40 flex justify-center pointer-events-none">
            <button
              onClick={() => setCommandBarVisible(true)}
              className="pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full border border-border/60 bg-background/90 text-muted-foreground shadow-lg backdrop-blur-md transition-colors hover:text-foreground"
              aria-label="Open command palette"
            >
              <Slash className="h-4 w-4" />
            </button>
          </div>
          <CommandBar
            open={commandBarVisible}
            onOpenChange={setCommandBarVisible}
            onCommand={() => setCommandBarVisible(false)}
            placeholder="Search commands or run a natural-language action..."
          />
        </>
      ) : null}
      <BottomNav />
    </div>
  );
}
