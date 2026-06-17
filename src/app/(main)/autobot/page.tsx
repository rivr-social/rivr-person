"use client";

import { AutobotHub } from "@/components/autobot-hub";

/**
 * /autobot — the Agent HQ configuration hub.
 *
 * A single tabbed surface for configuring the controller account and each
 * persona: Identity · Roles · Knowledge · Voice & Avatar · Connections ·
 * Activity, with a persistent persona roster above the tabs. The live
 * tmux/terminal console is preserved at /autobot/console.
 */
export default function AutobotPage() {
  return <AutobotHub />;
}
