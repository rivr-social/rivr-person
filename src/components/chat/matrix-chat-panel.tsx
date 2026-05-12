"use client";

/**
 * Reusable Matrix chat panel for rendering messages in a Matrix room.
 *
 * Listens to the Matrix sync timeline for real-time message updates.
 * Provides a message input for sending new messages.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Send, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBubble } from "./message-bubble";
import { AddToChatDialog } from "./add-to-chat-dialog";
import { addParticipantsToRoom } from "@/app/actions/matrix";
import { toast } from "@/components/ui/use-toast";
import { MsgType, RoomEvent } from "matrix-js-sdk";
import type { MatrixClient, MatrixEvent, Room } from "matrix-js-sdk";

interface ChatMessage {
  eventId: string;
  body: string;
  senderId: string;
  senderName: string;
  timestamp: number;
}

interface MatrixChatPanelProps {
  client: MatrixClient;
  roomId: string;
  currentUserId: string;
  roomName: string;
  roomAvatarUrl?: string | null;
  onBack?: () => void;
  /**
   * Called after `addParticipantsToRoom` returns. When the call promoted a
   * 1:1 DM to a new group room, `promotedRoomId` is the new room ID and the
   * parent should navigate the chat panel to it.
   */
  onParticipantsAdded?: (result: { promotedRoomId: string | null }) => void;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function MatrixChatPanel({
  client,
  roomId,
  currentUserId,
  roomName,
  roomAvatarUrl,
  onBack,
  onParticipantsAdded,
}: MatrixChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleAddParticipants = useCallback(
    async (agentIds: string[]) => {
      if (agentIds.length === 0) return;
      setAddingParticipants(true);
      try {
        const result = await addParticipantsToRoom(roomId, agentIds);
        const addedCount = result.added.length;
        const failedCount = result.failed.length;

        if (result.promotedToRoomId) {
          toast({
            title: "Conversation upgraded to group chat",
            description: `${addedCount} ${addedCount === 1 ? "person" : "people"} added.`,
          });
          onParticipantsAdded?.({ promotedRoomId: result.promotedToRoomId });
        } else if (addedCount > 0) {
          toast({
            title: `Added ${addedCount} to chat`,
            description:
              failedCount > 0
                ? `${failedCount} could not be added: ${result.failed
                    .map((f) => f.reason)
                    .join("; ")}`
                : undefined,
          });
          onParticipantsAdded?.({ promotedRoomId: null });
        } else {
          toast({
            title: "Could not add participants",
            description:
              result.failed.length > 0
                ? result.failed.map((f) => f.reason).join("; ")
                : "Unknown failure.",
            variant: "destructive",
          });
        }

        setAddOpen(false);
      } catch (err) {
        console.error("[matrix-chat] addParticipantsToRoom failed:", err);
        toast({
          title: "Could not add participants",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setAddingParticipants(false);
      }
    },
    [roomId, onParticipantsAdded],
  );

  // Load existing timeline from the room
  const loadTimeline = useCallback(() => {
    const room = client.getRoom(roomId);
    if (!room) return;

    const timeline = room.getLiveTimeline().getEvents();
    const chatMessages: ChatMessage[] = timeline
      .filter((ev: MatrixEvent) => ev.getType() === "m.room.message")
      .map((ev: MatrixEvent) => ({
        eventId: ev.getId() ?? "",
        body: ev.getContent().body ?? "",
        senderId: ev.getSender() ?? "",
        senderName:
          room.getMember(ev.getSender() ?? "")?.name ?? ev.getSender() ?? "",
        timestamp: ev.getTs(),
      }));

    setMessages(chatMessages);
  }, [client, roomId]);

  useEffect(() => {
    loadTimeline();

    // Listen for new messages in this room
    const onTimelineEvent = (
      event: MatrixEvent,
      room: Room | undefined
    ) => {
      if (room?.roomId !== roomId) return;
      if (event.getType() !== "m.room.message") return;

      const newMsg: ChatMessage = {
        eventId: event.getId() ?? "",
        body: event.getContent().body ?? "",
        senderId: event.getSender() ?? "",
        senderName:
          room?.getMember(event.getSender() ?? "")?.name ??
          event.getSender() ??
          "",
        timestamp: event.getTs(),
      };

      setMessages((prev) => {
        // Deduplicate (optimistic sends may already be in the list)
        if (prev.some((m) => m.eventId === newMsg.eventId)) return prev;
        return [...prev, newMsg];
      });
    };

    client.on(RoomEvent.Timeline, onTimelineEvent);

    return () => {
      client.removeListener(RoomEvent.Timeline, onTimelineEvent);
    };
  }, [client, roomId, loadTimeline]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // Mark room as read when viewing
  useEffect(() => {
    const room = client.getRoom(roomId);
    if (!room) return;

    const lastEvent = room.getLiveTimeline().getEvents().at(-1);
    if (lastEvent) {
      client.sendReadReceipt(lastEvent).catch(() => {});
    }
  }, [client, roomId, messages.length]);

  const handleSend = async () => {
    if (!messageText.trim() || sending) return;

    setSending(true);
    const text = messageText.trim();
    setMessageText("");

    try {
      await client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: text,
      });
    } catch (err) {
      console.error("[matrix-chat] Failed to send message:", err);
      setMessageText(text); // Restore on failure
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b flex items-center gap-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onBack}
            aria-label="Back to conversations"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}

        <Avatar>
          <AvatarImage src={roomAvatarUrl ?? undefined} alt={roomName} />
          <AvatarFallback>{initials(roomName)}</AvatarFallback>
        </Avatar>

        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{roomName}</p>
          <p className="text-xs text-muted-foreground">Direct messages</p>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="ml-auto"
          aria-label="Add to chat"
          onClick={() => setAddOpen(true)}
        >
          <UserPlus className="h-5 w-5" />
        </Button>
      </div>

      <AddToChatDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={handleAddParticipants}
        isAdding={addingParticipants}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map((msg) => (
          <MessageBubble
            key={msg.eventId}
            body={msg.body}
            timestamp={msg.timestamp}
            isCurrentUser={msg.senderId === currentUserId}
            senderName={msg.senderName}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t">
        <div className="flex gap-2">
          <Input
            placeholder="Type a message..."
            value={messageText}
            onChange={(e) => setMessageText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            className="rounded-full"
          />
          <Button
            onClick={() => void handleSend()}
            disabled={!messageText.trim() || sending}
            size="icon"
            className="rounded-full"
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
