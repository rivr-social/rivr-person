"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

const ExecutiveLauncher = dynamic(
  () => import("@/components/executive-launcher").then((mod) => mod.ExecutiveLauncher),
  { ssr: false },
);

type SaveTargetOption = {
  id: string;
  label: string;
};

interface ExecutiveLauncherHostProps {
  personas?: SaveTargetOption[];
  groups?: SaveTargetOption[];
}

export function ExecutiveLauncherHost({ personas, groups }: ExecutiveLauncherHostProps) {
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  // Hide on /autobot — that page IS the executive interface
  if (pathname === "/autobot") {
    return null;
  }

  return <ExecutiveLauncher personas={personas} groups={groups} />;
}
