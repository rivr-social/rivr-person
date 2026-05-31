"use client";

/**
 * AgentVoiceTab — Voice & Avatar configuration.
 *
 * The full native voice-clone + TTS pipeline (running on the pluggable GPU)
 * is being designed separately and is intentionally not wired here yet. This
 * tab surfaces the current voice settings entry points so the surface is
 * complete, and will host the clone/TTS controls once that plan lands.
 */

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AudioLines, ExternalLink } from "lucide-react";

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
          Voice and 3D avatar settings for <strong>{agentLabel}</strong>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-dashed border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
          Native voice cloning and text-to-speech run on the pluggable GPU
          backend. That pipeline is being finalized separately and will appear
          here once ready. Voice style and 3D avatar can be set today in the
          identity editor.
        </div>
        <div className="flex justify-end">
          <Button asChild variant="outline" className="gap-2">
            <Link href={editHref}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open identity editor
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
