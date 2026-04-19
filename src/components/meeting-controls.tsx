/**
 * Meeting controls component for events and standalone meetings.
 *
 * Provides:
 * - Quick-join button for events with active meetings
 * - Participant count badge
 * - Recording/livestream status indicator
 * - Create meeting button for events without an active meeting
 *
 * Usage:
 *   <MeetingControls eventId="..." />          -- for event-linked meetings
 *   <MeetingControls roomName="..." />          -- for standalone room join
 */
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Video,
  Users,
  Radio,
  Loader2,
  PhoneCall,
  Plus,
  AlertCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;

const MEETING_STATUS_ACTIVE = "active";
const MEETING_STATUS_STREAMING = "streaming";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventMeetingStatus {
  status: string;
  roomName: string | null;
  numParticipants: number;
}

interface LivestreamStatus {
  status: string;
  egresses: { egressId: string; status: number; startedAt: number | null }[];
}

interface MeetingControlsProps {
  /** Event resource ID — used to create/join an event-linked meeting. */
  eventId?: string;
  /** Standalone room name — used for direct room join. */
  roomName?: string;
  /** Compact mode hides text labels. */
  compact?: boolean;
  /** Additional CSS class names. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MeetingControls({
  eventId,
  roomName: directRoomName,
  compact = false,
  className = "",
}: MeetingControlsProps) {
  const router = useRouter();
  const [meetingStatus, setMeetingStatus] = useState<EventMeetingStatus | null>(null);
  const [livestreamStatus, setLivestreamStatus] = useState<LivestreamStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Derive the effective room name from event status or direct prop.
  const effectiveRoom = meetingStatus?.roomName ?? directRoomName ?? null;

  // -------------------------------------------------------------------------
  // Polling: fetch event meeting status
  // -------------------------------------------------------------------------

  const fetchEventStatus = useCallback(async () => {
    if (!eventId) return;
    try {
      const res = await fetch(`/api/events/${eventId}/meeting`);
      if (res.ok) {
        const data: EventMeetingStatus = await res.json();
        setMeetingStatus(data);
      }
    } catch {
      // Silently ignore polling errors.
    }
  }, [eventId]);

  const fetchLivestreamStatus = useCallback(async () => {
    if (!effectiveRoom) return;
    try {
      const res = await fetch(`/api/meetings/${effectiveRoom}/livestream`);
      if (res.ok) {
        const data: LivestreamStatus = await res.json();
        setLivestreamStatus(data);
      }
    } catch {
      // Silently ignore polling errors.
    }
  }, [effectiveRoom]);

  useEffect(() => {
    fetchEventStatus();
    const interval = setInterval(fetchEventStatus, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchEventStatus]);

  useEffect(() => {
    if (effectiveRoom) {
      fetchLivestreamStatus();
      const interval = setInterval(fetchLivestreamStatus, POLL_INTERVAL_MS);
      return () => clearInterval(interval);
    }
  }, [effectiveRoom, fetchLivestreamStatus]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const handleCreateMeeting = useCallback(async () => {
    if (!eventId) return;
    setCreating(true);
    setError(null);

    try {
      const res = await fetch(`/api/events/${eventId}/meeting`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to create meeting: ${res.status}`);
      }

      const data = await res.json();
      router.push(`/meetings/${data.roomName}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create meeting";
      setError(message);
    } finally {
      setCreating(false);
    }
  }, [eventId, router]);

  const handleJoin = useCallback(() => {
    if (!effectiveRoom) return;
    router.push(`/meetings/${effectiveRoom}`);
  }, [effectiveRoom, router]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const isActive = meetingStatus?.status === MEETING_STATUS_ACTIVE;
  const isStreaming = livestreamStatus?.status === MEETING_STATUS_STREAMING;
  const participantCount = meetingStatus?.numParticipants ?? 0;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <TooltipProvider>
      <div className={`inline-flex items-center gap-2 ${className}`}>
        {/* Error display */}
        {error && (
          <Tooltip>
            <TooltipTrigger>
              <AlertCircle className="h-4 w-4 text-destructive" />
            </TooltipTrigger>
            <TooltipContent>{error}</TooltipContent>
          </Tooltip>
        )}

        {/* Livestream indicator */}
        {isStreaming && (
          <Badge variant="destructive" className="gap-1 animate-pulse">
            <Radio className="h-3 w-3" />
            {!compact && "LIVE"}
          </Badge>
        )}

        {/* Participant count */}
        {isActive && participantCount > 0 && (
          <Badge variant="secondary" className="gap-1">
            <Users className="h-3 w-3" />
            {participantCount}
          </Badge>
        )}

        {/* Join / Create button */}
        {isActive && effectiveRoom ? (
          <Button
            size={compact ? "icon" : "sm"}
            onClick={handleJoin}
            disabled={loading}
            className="gap-1"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PhoneCall className="h-4 w-4" />
            )}
            {!compact && "Join Meeting"}
          </Button>
        ) : directRoomName ? (
          <Button
            size={compact ? "icon" : "sm"}
            onClick={handleJoin}
            className="gap-1"
          >
            <Video className="h-4 w-4" />
            {!compact && "Join"}
          </Button>
        ) : eventId ? (
          <Button
            size={compact ? "icon" : "sm"}
            variant="outline"
            onClick={handleCreateMeeting}
            disabled={creating}
            className="gap-1"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {!compact && "Start Meeting"}
          </Button>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
