/**
 * Meeting room page.
 *
 * Route: /meetings/[roomName]
 *
 * Uses @livekit/components-react for the video conference UI including:
 * - Video grid with automatic layout
 * - Audio/video toggle controls
 * - Screen sharing
 * - Chat sidebar
 * - Recording indicator
 * - Join/leave controls
 *
 * Flow:
 * 1. User lands on the page and sees a pre-join screen.
 * 2. Clicks "Join" to request a token from /api/meetings/[roomName]/token.
 * 3. Connects to the LiveKit room with the token.
 * 4. Can leave or disconnect at any time.
 */
"use client";

import { useState, useCallback, use } from "react";
import {
  LiveKitRoom,
  VideoConference,
  RoomAudioRenderer,
  ControlBar,
  GridLayout,
  ParticipantTile,
  useTracks,
  Chat,
  DisconnectButton,
} from "@livekit/components-react";
import "@livekit/components-styles";
import { Track } from "livekit-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Video,
  VideoOff,
  Mic,
  MicOff,
  MonitorUp,
  MessageSquare,
  Phone,
  PhoneOff,
  Radio,
  Loader2,
  AlertCircle,
  Users,
  Copy,
  Check,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREJOIN_TITLE = "Join Meeting";
const CONNECTING_LABEL = "Connecting...";
const DISCONNECTED_LABEL = "You have left the meeting";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TokenResponse {
  token: string;
  url: string;
}

interface MeetingPageProps {
  params: Promise<{ roomName: string }>;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function MeetingPage({ params }: MeetingPageProps) {
  const { roomName } = use(params);
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleJoin = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/meetings/${roomName}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Token request failed: ${response.status}`);
      }

      const data: TokenResponse = await response.json();
      setToken(data.token);
      setServerUrl(data.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to join meeting";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [roomName]);

  const handleDisconnect = useCallback(() => {
    setToken(null);
    setServerUrl(null);
    setDisconnected(true);
  }, []);

  const handleRejoin = useCallback(() => {
    setDisconnected(false);
    handleJoin();
  }, [handleJoin]);

  const handleCopyLink = useCallback(async () => {
    const url = `${window.location.origin}/meetings/${roomName}`;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomName]);

  // -------------------------------------------------------------------------
  // Disconnected state
  // -------------------------------------------------------------------------

  if (disconnected) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <PhoneOff className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
            <CardTitle>{DISCONNECTED_LABEL}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button onClick={handleRejoin} className="w-full">
              Rejoin Meeting
            </Button>
            <Button
              variant="outline"
              onClick={() => window.history.back()}
              className="w-full"
            >
              Go Back
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Pre-join state
  // -------------------------------------------------------------------------

  if (!token || !serverUrl) {
    return (
      <div className="flex min-h-[80vh] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <Video className="mx-auto mb-4 h-12 w-12 text-primary" />
            <CardTitle>{PREJOIN_TITLE}</CardTitle>
            <p className="mt-2 text-sm text-muted-foreground">
              Room: <span className="font-mono">{roomName}</span>
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {error && (
              <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}
            <Button onClick={handleJoin} disabled={loading} className="w-full">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {CONNECTING_LABEL}
                </>
              ) : (
                <>
                  <Phone className="mr-2 h-4 w-4" />
                  Join Meeting
                </>
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleCopyLink}
              className="w-full"
            >
              {copied ? (
                <>
                  <Check className="mr-2 h-4 w-4" />
                  Link Copied
                </>
              ) : (
                <>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy Invite Link
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Connected / in-meeting state
  // -------------------------------------------------------------------------

  return (
    <div className="h-[calc(100dvh-4rem)]">
      <LiveKitRoom
        serverUrl={serverUrl}
        token={token}
        connect={true}
        video={true}
        audio={true}
        onDisconnected={handleDisconnect}
        data-lk-theme="default"
        style={{ height: "100%" }}
      >
        <MeetingLayout roomName={roomName} onCopyLink={handleCopyLink} copied={copied} />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner layout (rendered inside LiveKitRoom context)
// ---------------------------------------------------------------------------

function MeetingLayout({
  roomName,
  onCopyLink,
  copied,
}: {
  roomName: string;
  onCopyLink: () => void;
  copied: boolean;
}) {
  const [showChat, setShowChat] = useState(false);

  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b bg-background/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="font-mono text-xs">
            {roomName}
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <Users className="h-3 w-3" />
            {tracks.filter((t) => t.source === Track.Source.Camera).length}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyLink}
            className="gap-1"
          >
            {copied ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Invite
          </Button>
          <Button
            variant={showChat ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setShowChat((prev) => !prev)}
            className="gap-1"
          >
            <MessageSquare className="h-4 w-4" />
            Chat
          </Button>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Video grid */}
        <div className="flex-1">
          <GridLayout tracks={tracks} style={{ height: "100%" }}>
            <ParticipantTile />
          </GridLayout>
        </div>

        {/* Chat sidebar */}
        {showChat && (
          <div className="w-80 border-l">
            <Chat style={{ height: "100%" }} />
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="border-t bg-background/95 backdrop-blur">
        <ControlBar
          variation="verbose"
          controls={{
            camera: true,
            microphone: true,
            screenShare: true,
            leave: true,
            chat: false,
          }}
        />
      </div>
    </div>
  );
}
