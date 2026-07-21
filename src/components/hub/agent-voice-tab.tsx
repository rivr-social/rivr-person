"use client";

/**
 * AgentVoiceTab — Voice & Avatar configuration.
 *
 * Hosts the real voice-clone recorder (record or upload a reference
 * sample; it conditions Chatterbox synthesis on the user's own Vast GPU)
 * plus links to the full voice settings drawer and the identity editor.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { VoiceCloneUpload } from "@/components/voice-clone-upload";
import { AudioLines, ExternalLink, Settings2 } from "lucide-react";

interface AgentVoiceTabProps {
  agentLabel: string;
  editHref: string;
}

export function AgentVoiceTab({ agentLabel, editHref }: AgentVoiceTabProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AudioLines className="h-4 w-4" /> Voice &amp; Avatar
        </CardTitle>
        <CardDescription>
          Record a voice sample for <strong>{agentLabel}</strong> — the live
          avatar and spoken replies use it to speak in your voice (synthesized
          on your GPU; the recording never trains anything, it only conditions
          each utterance).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <VoiceCloneUpload />
        <p className="text-xs text-muted-foreground">
          Tip: after the on-screen script, keep talking naturally for a total
          of 30–60 seconds — the clone copies how you sound, not what you say.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline" className="gap-2">
            <Link href="/autobot/chat?settings=voice">
              <Settings2 className="h-3.5 w-3.5" />
              Full voice settings
            </Link>
          </Button>
          <Button asChild variant="outline" className="gap-2">
            <Link href={editHref}>
              <ExternalLink className="h-3.5 w-3.5" />
              Identity editor
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
