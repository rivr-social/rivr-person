"use client";

/**
 * Add to Chat dialog — searches the social graph, multi-selects agents,
 * and adds them to an existing Matrix room via `addParticipantsToRoom`.
 *
 * Reused by both `MatrixChatPanel` (DM rooms; triggers 1:1→group promotion
 * when 2-member rooms gain participants) and `GroupChatPanel` (group rooms;
 * just force-joins new members).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { searchAgentsByName } from "@/app/actions/graph";
import type { SerializedAgent } from "@/lib/graph-serializers";

const DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 15;

interface SelectedAgent {
  id: string;
  name: string;
  image: string | null;
}

interface AddToChatDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the selected agent IDs when the user clicks Add. */
  onAdd: (agentIds: string[]) => Promise<void> | void;
  /** Whether the parent is currently processing an add (disables the button). */
  isAdding?: boolean;
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function AddToChatDialog({
  open,
  onOpenChange,
  onAdd,
  isAdding,
}: AddToChatDialogProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SerializedAgent[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SelectedAgent[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const search = useCallback(async (term: string) => {
    if (term.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    try {
      const agents = await searchAgentsByName(term.trim(), SEARCH_LIMIT);
      setResults(agents);
    } catch (err) {
      console.error("[add-to-chat] search failed:", err);
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(() => {
      void search(query);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSearching(false);
      setSelected([]);
    }
  }, [open]);

  const handleToggle = (agent: SerializedAgent) => {
    setSelected((prev) => {
      const exists = prev.find((u) => u.id === agent.id);
      if (exists) return prev.filter((u) => u.id !== agent.id);
      return [...prev, { id: agent.id, name: agent.name, image: agent.image }];
    });
    setQuery("");
    setResults([]);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleRemove = (id: string) => {
    setSelected((prev) => prev.filter((u) => u.id !== id));
  };

  const handleSubmit = async () => {
    if (selected.length === 0 || isAdding) return;
    const ids = selected.map((u) => u.id);
    await onAdd(ids);
  };

  const selectedIds = new Set(selected.map((u) => u.id));
  const filtered = results.filter((a) => !selectedIds.has(a.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to chat</DialogTitle>
          <DialogDescription>
            Search for people to bring into this conversation. Adding to a
            1-on-1 chat upgrades it to a group chat.
          </DialogDescription>
        </DialogHeader>

        {selected.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selected.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-1.5 bg-muted rounded-full pl-1 pr-2 py-1"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage src={user.image ?? undefined} alt={user.name} />
                  <AvatarFallback className="text-xs">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium truncate max-w-[120px]">
                  {user.name}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(user.id)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-muted-foreground/20 transition-colors"
                  aria-label={`Remove ${user.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            ref={inputRef}
            type="search"
            placeholder="Search by name..."
            className="pl-10"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>

        <div className="max-h-60 overflow-y-auto -mx-2">
          {searching && (
            <p className="text-center text-sm text-muted-foreground py-4">
              Searching...
            </p>
          )}

          {!searching && query.trim().length >= 2 && filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-4">
              No matches
            </p>
          )}

          {filtered.map((agent) => {
            const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
            const username =
              typeof metadata.username === "string" ? metadata.username : "";
            return (
              <button
                key={agent.id}
                type="button"
                className="w-full text-left flex items-center gap-3 px-2 py-3 rounded-md hover:bg-muted/50 transition-colors"
                onClick={() => handleToggle(agent)}
              >
                <Avatar className="h-10 w-10">
                  <AvatarImage src={agent.image ?? undefined} alt={agent.name} />
                  <AvatarFallback>{initials(agent.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{agent.name}</p>
                  {username && (
                    <p className="text-sm text-muted-foreground truncate">
                      @{username}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        <Button
          onClick={() => void handleSubmit()}
          disabled={selected.length === 0 || isAdding}
          className="w-full"
        >
          {isAdding
            ? "Adding..."
            : selected.length === 0
              ? "Add"
              : `Add ${selected.length} ${selected.length === 1 ? "person" : "people"}`}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
