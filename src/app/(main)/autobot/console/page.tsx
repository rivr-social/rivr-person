"use client";

import { AgentHqConsole } from "@/components/agent-hq-console";

/**
 * /autobot/console — the live Agent HQ terminal console.
 *
 * This is the preserved tmux/session terminal surface (pane graph + xterm
 * viewer + DB explorer). The main `/autobot` route is now the configuration
 * hub; this console is linked from the hub's Activity tab and the header.
 */
export default function AgentHqConsolePage() {
  return <AgentHqConsole />;
}
