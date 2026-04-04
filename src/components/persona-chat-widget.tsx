"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Bot, Loader2, MessageSquare, Minimize2, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 4000;
const MAX_DISPLAY_MESSAGES = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface PersonaChatResponse {
  reply: string;
  model?: string;
  personaName?: string;
  personaUsername?: string;
  personaImage?: string | null;
  error?: string;
}

type WidgetState = "collapsed" | "expanded";
type SendState = "idle" | "sending";

interface PersonaChatWidgetProps {
  /** The username of the profile being viewed */
  username: string;
  /** Display name of the persona owner */
  personaName: string;
  /** Avatar image URL */
  personaImage: string | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PersonaChatWidget({
  username,
  personaName,
  personaImage,
}: PersonaChatWidgetProps) {
  const { data: session } = useSession();
  const [widgetState, setWidgetState] = useState<WidgetState>("collapsed");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [sendState, setSendState] = useState<SendState>("idle");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isAuthenticated = Boolean(session?.user?.id);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when widget expands
  useEffect(() => {
    if (widgetState === "expanded" && inputRef.current) {
      // Small delay to let animation settle
      const timer = setTimeout(() => inputRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [widgetState]);

  const sendMessage = useCallback(async () => {
    const trimmed = inputValue.trim();
    if (!trimmed || sendState === "sending") return;

    if (trimmed.length > MAX_MESSAGE_LENGTH) {
      setError(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
      return;
    }

    setError(null);

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev.slice(-MAX_DISPLAY_MESSAGES + 1), userMessage]);
    setInputValue("");
    setSendState("sending");

    // Build history from existing messages for context
    const history = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    try {
      const response = await fetch(
        `/api/profile/${encodeURIComponent(username)}/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: trimmed, history }),
        },
      );

      const data: PersonaChatResponse = await response.json();

      if (!response.ok || data.error) {
        setError(data.error || `Request failed (${response.status})`);
        setSendState("idle");
        return;
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.reply,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [
        ...prev.slice(-MAX_DISPLAY_MESSAGES + 1),
        assistantMessage,
      ]);
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Failed to send message",
      );
    } finally {
      setSendState("idle");
    }
  }, [inputValue, messages, sendState, username]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  // Collapsed state: floating button
  if (widgetState === "collapsed") {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <Button
          onClick={() => setWidgetState("expanded")}
          className="h-14 w-14 rounded-full shadow-lg"
          size="icon"
          title={`Chat with ${personaName}'s AI persona`}
        >
          <MessageSquare className="h-6 w-6" />
        </Button>
      </div>
    );
  }

  // Expanded state: chat panel
  return (
    <div className="fixed bottom-6 right-6 z-50 w-[360px] max-w-[calc(100vw-2rem)]">
      <Card className="flex flex-col shadow-2xl border overflow-hidden max-h-[520px]">
        {/* Header */}
        <CardHeader className="flex flex-row items-center gap-3 px-4 py-3 border-b bg-muted/30">
          <div className="relative h-9 w-9 rounded-full bg-muted overflow-hidden flex-shrink-0">
            {personaImage ? (
              <Image
                src={personaImage}
                alt={personaName}
                width={36}
                height={36}
                className="h-full w-full object-cover"
                unoptimized
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Bot className="h-5 w-5 text-muted-foreground" />
              </div>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{personaName}</p>
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 py-0 leading-4"
            >
              AI Persona
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setWidgetState("collapsed")}
              title="Minimize"
            >
              <Minimize2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => {
                setWidgetState("collapsed");
                setMessages([]);
                setError(null);
              }}
              title="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col flex-1 p-0 overflow-hidden">
          {/* AI disclosure banner */}
          <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b text-[11px] text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
            <Bot className="h-3 w-3 flex-shrink-0" />
            <span>
              This is an AI persona, not {personaName} directly. Responses are
              generated by AI based on their public profile.
            </span>
          </div>

          {/* Message area */}
          <ScrollArea className="flex-1 min-h-0" style={{ maxHeight: "340px" }}>
            <div ref={scrollRef} className="px-3 py-3 space-y-3">
              {messages.length === 0 ? (
                <div className="text-center py-8 space-y-2">
                  <Bot className="h-8 w-8 mx-auto text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">
                    Send a message to start chatting with {personaName}&apos;s AI
                    persona.
                  </p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex",
                      msg.role === "user" ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] rounded-xl px-3 py-2 text-sm",
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {msg.content}
                      </p>
                      <p
                        className={cn(
                          "text-[10px] mt-1 opacity-60",
                          msg.role === "user"
                            ? "text-primary-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {new Date(msg.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                ))
              )}

              {sendState === "sending" ? (
                <div className="flex justify-start">
                  <div className="bg-muted rounded-xl px-3 py-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                </div>
              ) : null}
            </div>
          </ScrollArea>

          {/* Error display */}
          {error ? (
            <div className="px-3 py-2 border-t bg-destructive/5 text-xs text-destructive">
              {error}
            </div>
          ) : null}

          {/* Input area */}
          <div className="px-3 py-3 border-t">
            {isAuthenticated ? (
              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={`Message ${personaName}'s persona...`}
                  maxLength={MAX_MESSAGE_LENGTH}
                  disabled={sendState === "sending"}
                  className="flex-1 text-sm"
                />
                <Button
                  size="icon"
                  className="h-9 w-9 flex-shrink-0"
                  onClick={() => void sendMessage()}
                  disabled={
                    sendState === "sending" || inputValue.trim().length === 0
                  }
                >
                  {sendState === "sending" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground text-center py-1">
                Sign in to chat with this persona.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
