"use client";

// ---------------------------------------------------------------------------
// Composer blocks
//
// Reusable Subject-Verb-Object authoring widgets shared by the Explore graph
// query composer and the per-document ABAC rule editor:
//   - SearchableDropdown  — agent/resource picker with type dot + search
//   - VerbDropdown        — grouped verb picker, optionally constrained
//   - DeterminerDropdown  — any / my / the / that / a / all
//   - ConditionBlock      — one [det] who [verb] [det] what row
//   - parseNlpToComposer  — natural-language → condition/action mapping
//
// All vocabulary + types live in ./composer-vocab so both authoring surfaces
// speak the same grammar.
// ---------------------------------------------------------------------------

import { useState, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Search, X } from "lucide-react";
import { parseNaturalLanguageV2 } from "@/lib/nlp-parser-v2";
import {
  VERB_GROUPS,
  ALL_VERBS,
  TYPE_COLORS,
  WILDCARD_AGENTS,
  AGENT_DETERMINERS,
  RESOURCE_DETERMINERS,
  VERB_RESOURCE_TYPES,
  RESOURCE_TYPE_VERBS,
  AGENT_VERBS,
  KNOWN_DETERMINERS,
  AGENT_TYPE_KEYWORDS,
  type QueryCondition,
  type ThenAction,
  type DropdownOption,
} from "./composer-vocab";

// ─── Searchable Dropdown ────────────────────────────────────────────────────

export function SearchableDropdown({
  options,
  value,
  onSelect,
  onClear,
  placeholder,
  label,
}: {
  options: DropdownOption[];
  value?: { id: string; name: string; type: string };
  onSelect: (opt: DropdownOption) => void;
  onClear: () => void;
  placeholder: string;
  label: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = search
    ? options.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : options;

  const displayFiltered = filtered.slice(0, 50);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-[100px] max-w-[160px] h-8 px-2.5 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors text-left truncate"
          title={label}
        >
          {value ? (
            <span className="flex items-center gap-1.5 truncate">
              <span
                className="inline-block h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: TYPE_COLORS[value.type] ?? "#6b7280" }}
              />
              <span className="truncate">{value.name}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={`Search ${label.toLowerCase()}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {displayFiltered.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-3">No results</p>
          ) : (
            displayFiltered.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent transition-colors text-left"
                onClick={() => {
                  onSelect(opt);
                  setSearch("");
                  setOpen(false);
                }}
              >
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: TYPE_COLORS[opt.type] ?? "#6b7280" }}
                />
                <span className="truncate">{opt.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground capitalize shrink-0">
                  {opt.type}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Verb Dropdown ──────────────────────────────────────────────────────────

export function VerbDropdown({
  value,
  onSelect,
  onClear,
  allowedVerbs,
}: {
  value?: string;
  onSelect: (verb: string) => void;
  onClear: () => void;
  /** When set, only these verbs are shown (filtered by selected resource type) */
  allowedVerbs?: Set<string>;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filteredGroups = useMemo(() => {
    let groups = VERB_GROUPS;

    // Filter by allowed verbs (from resource type selection)
    if (allowedVerbs) {
      groups = groups
        .map((g) => ({
          ...g,
          verbs: g.verbs.filter((v) => allowedVerbs.has(v)),
        }))
        .filter((g) => g.verbs.length > 0);
    }

    // Filter by search text
    if (search) {
      groups = groups
        .map((g) => ({
          ...g,
          verbs: g.verbs.filter((v) => v.includes(search.toLowerCase())),
        }))
        .filter((g) => g.verbs.length > 0);
    }

    return groups;
  }, [allowedVerbs, search]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 min-w-[90px] max-w-[130px] h-8 px-2.5 rounded-md border border-border bg-background text-sm hover:bg-accent transition-colors text-left truncate"
        >
          {value ? (
            <span className="flex items-center gap-1.5 truncate">
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                {value.replace("_", " ")}
              </Badge>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear();
                }}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ) : (
            <span className="text-muted-foreground truncate">does what</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0" align="start">
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search verbs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-7 text-xs"
              autoFocus
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filteredGroups.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-semibold text-muted-foreground px-3 pt-2 pb-0.5 uppercase tracking-wider">
                {group.label}
              </p>
              {group.verbs.map((verb) => (
                <button
                  key={verb}
                  type="button"
                  className={`w-full px-3 py-1 text-xs hover:bg-accent transition-colors text-left ${
                    value === verb ? "bg-accent font-medium" : ""
                  }`}
                  onClick={() => {
                    onSelect(verb);
                    setSearch("");
                    setOpen(false);
                  }}
                >
                  {verb.replace("_", " ")}
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── Determiner Dropdown ─────────────────────────────────────────────────────

export function DeterminerDropdown({
  value,
  options,
  onSelect,
}: {
  value?: string;
  options: readonly string[];
  onSelect: (det: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center justify-center min-w-[40px] h-8 px-1.5 rounded-md border border-dashed border-border/60 bg-background text-[11px] italic text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
        >
          {value || "any"}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-24 p-1" align="start">
        {options.map((det) => (
          <button
            key={det}
            type="button"
            className={`w-full px-2 py-1 text-xs text-left rounded hover:bg-accent transition-colors ${
              value === det ? "bg-accent font-medium" : ""
            }`}
            onClick={() => {
              onSelect(det);
              setOpen(false);
            }}
          >
            {det}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// ─── Condition Block (one SVO row) ───────────────────────────────────────────

/**
 * One Subject-Verb-Object condition row:
 *   [det] who [verb] [det] what
 *
 * Contextual filtering narrows verbs by the selected resource type and
 * resources by the selected verb. Agent-targeting verbs (join/follow/…) swap
 * the object slot to show agents instead of resources. The `when` label adds a
 * date-range pair (used by the Explore trigger row).
 */
export function ConditionBlock({
  label,
  condition,
  agents,
  resources,
  onChange,
}: {
  label: string;
  condition: QueryCondition;
  agents: DropdownOption[];
  resources: DropdownOption[];
  onChange: (c: QueryCondition) => void;
}) {
  const agentOptions: DropdownOption[] = [...WILDCARD_AGENTS, ...agents];

  // Contextual filtering: verb → resource types, resource type → verbs
  const isAgentVerb = condition.verb ? AGENT_VERBS.has(condition.verb) : false;
  const allowedResourceTypes = useMemo(() => {
    if (!condition.verb) return undefined;
    const types = VERB_RESOURCE_TYPES[condition.verb];
    return types && types.length > 0 ? new Set(types) : undefined;
  }, [condition.verb]);

  const allowedVerbs = useMemo(() => {
    if (!condition.resourceType) return undefined;
    const verbs = RESOURCE_TYPE_VERBS[condition.resourceType];
    return verbs ? new Set(verbs) : undefined;
  }, [condition.resourceType]);

  // Filter resources by verb selection; if agent verb, show agents in the "what" slot
  const filteredResources = useMemo(() => {
    if (isAgentVerb) return []; // agent verbs show agents, not resources
    if (!allowedResourceTypes) return resources;
    return resources.filter((r) => allowedResourceTypes.has(r.type));
  }, [resources, allowedResourceTypes, isAgentVerb]);

  // For agent verbs, the "with what" slot shows agents instead
  const objectOptions = isAgentVerb ? agentOptions : filteredResources;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {/* Row label */}
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground w-10 shrink-0">
        {label}
      </span>

      {/* [det] Who */}
      <DeterminerDropdown
        value={condition.agentDeterminer}
        options={AGENT_DETERMINERS}
        onSelect={(det) => onChange({ ...condition, agentDeterminer: det })}
      />
      <SearchableDropdown
        options={agentOptions}
        value={
          condition.agentId
            ? { id: condition.agentId, name: condition.agentName ?? "Unknown", type: condition.agentType ?? "person" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...condition, agentId: opt.id, agentName: opt.name, agentType: opt.type })
        }
        onClear={() =>
          onChange({ ...condition, agentId: undefined, agentName: undefined, agentType: undefined })
        }
        placeholder="who"
        label="Agent"
      />

      {/* Does what — filtered by selected resource type */}
      <VerbDropdown
        value={condition.verb}
        onSelect={(verb) => onChange({ ...condition, verb })}
        onClear={() => onChange({ ...condition, verb: undefined })}
        allowedVerbs={allowedVerbs}
      />

      {/* [det] With what — filtered by selected verb */}
      <DeterminerDropdown
        value={condition.resourceDeterminer}
        options={isAgentVerb ? AGENT_DETERMINERS : RESOURCE_DETERMINERS}
        onSelect={(det) => onChange({ ...condition, resourceDeterminer: det })}
      />
      <SearchableDropdown
        options={objectOptions}
        value={
          condition.resourceId
            ? { id: condition.resourceId, name: condition.resourceName ?? "Unknown", type: condition.resourceType ?? "resource" }
            : undefined
        }
        onSelect={(opt) =>
          onChange({ ...condition, resourceId: opt.id, resourceName: opt.name, resourceType: opt.type })
        }
        onClear={() =>
          onChange({ ...condition, resourceId: undefined, resourceName: undefined, resourceType: undefined })
        }
        placeholder={isAgentVerb ? "whom" : "what"}
        label={isAgentVerb ? "Agent" : "Resource"}
      />

      {/* Date range (only for WHEN) */}
      {label === "when" && (
        <div className="flex items-center gap-1">
          <Input
            type="date"
            value={condition.startDate ?? ""}
            onChange={(e) => onChange({ ...condition, startDate: e.target.value || undefined })}
            className="h-8 w-[110px] text-xs"
            placeholder="from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={condition.endDate ?? ""}
            onChange={(e) => onChange({ ...condition, endDate: e.target.value || undefined })}
            className="h-8 w-[110px] text-xs"
            placeholder="to"
          />
        </div>
      )}
    </div>
  );
}

// ─── NLP → Composer Mapping ──────────────────────────────────────────────────

/**
 * Parse a natural language sentence and map it to composer state.
 * Returns partial state for WHEN, THEN actions, and IF condition.
 */
export function parseNlpToComposer(
  input: string,
  agents: DropdownOption[],
  resources: DropdownOption[],
): {
  when: QueryCondition;
  thenActions: ThenAction[];
  ifCondition: QueryCondition;
  hasIf: boolean;
} {
  const result = parseNaturalLanguageV2(input);
  const when: QueryCondition = {};
  const thenActions: ThenAction[] = [];
  const ifCondition: QueryCondition = {};
  let hasIf = false;

  const lowerInput = input.toLowerCase();

  // Helper: find an agent by name match
  const findAgent = (name: string): DropdownOption | undefined => {
    const lower = name.toLowerCase();
    return agents.find((a) => a.name.toLowerCase() === lower);
  };

  // Helper: find a resource by name match
  const findResource = (name: string): DropdownOption | undefined => {
    const lower = name.toLowerCase();
    return resources.find((r) => r.name.toLowerCase() === lower);
  };

  // Helper: find a verb in the input near a position
  const findVerb = (text: string): string | undefined => {
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
      // Check direct match
      if (ALL_VERBS.includes(word)) return word;
      // Check with 's' stripped (buys → buy)
      if (word.endsWith("s") && ALL_VERBS.includes(word.slice(0, -1))) return word.slice(0, -1);
      // Check common verb forms
      const verbMap: Record<string, string> = {
        buys: "buy", sells: "sell", trades: "trade", gifts: "gift", gives: "give",
        delivers: "transfer", deliver: "transfer", sends: "transfer", send: "transfer",
        assigns: "assign", creates: "create", updates: "update", joins: "join",
        follows: "follow", manages: "manage", approves: "approve", rejects: "reject",
        endorses: "endorse", shares: "share", produces: "produce", consumes: "consume",
        attends: "attend", hosts: "host", schedules: "schedule", earns: "earn",
        publishes: "publish", starts: "start", completes: "complete", cancels: "cancel",
      };
      if (verbMap[word]) return verbMap[word];
    }
    return undefined;
  };

  // Helper: extract determiner from text before a noun
  const extractDeterminer = (text: string, nounName: string): string | undefined => {
    const idx = text.toLowerCase().indexOf(nounName.toLowerCase());
    if (idx < 0) return undefined;
    const before = text.slice(0, idx).trim().split(/\s+/);
    const lastWord = before[before.length - 1]?.toLowerCase();
    if (lastWord && KNOWN_DETERMINERS.has(lastWord)) return lastWord === "every" || lastWord === "each" ? "any" : lastWord;
    return undefined;
  };

  // Split on "when" / "whenever" to extract trigger vs action
  const whenMatch = lowerInput.match(/^(?:when(?:ever)?|if)\s+(.+?)(?:,\s*(?:then\s+)?|(?:\s+then\s+))(.+)$/i);

  if (whenMatch) {
    const whenPart = whenMatch[1].trim();
    const thenPart = whenMatch[2].trim();

    // Parse WHEN part
    const whenVerb = findVerb(whenPart);
    if (whenVerb) when.verb = whenVerb;

    // Try to find subject and object in the WHEN clause
    for (const entity of result.entities) {
      if (whenPart.toLowerCase().includes(entity.name.toLowerCase())) {
        const det = extractDeterminer(whenPart, entity.name);
        const isAgent = entity.targetTable === "agents" || AGENT_TYPE_KEYWORDS.has(entity.type);
        if (isAgent && !when.agentId) {
          const found = findAgent(entity.name);
          if (found) {
            when.agentId = found.id;
            when.agentName = found.name;
            when.agentType = found.type;
          }
          when.agentDeterminer = det;
        } else if (!isAgent && !when.resourceId) {
          const found = findResource(entity.name);
          if (found) {
            when.resourceId = found.id;
            when.resourceName = found.name;
            when.resourceType = found.type;
          }
          when.resourceDeterminer = det;
        }
      }
    }

    // If WHEN has "any person" pattern without a specific entity
    if (!when.agentId && whenPart.match(/\bany\s+(person|people|user|member)\b/i)) {
      when.agentDeterminer = "any";
    }
    if (!when.agentId && whenPart.match(/\bany\s+(group|org|organization|team)\b/i)) {
      when.agentDeterminer = "any";
    }

    // Parse THEN part — split on "and then" or "and" for chaining
    const thenParts = thenPart.split(/\s+and\s+then\s+|\s+and\s+(?=\w+\s+(?:the|my|a|that|any)\s+)/i);

    for (const part of thenParts) {
      const action: ThenAction = {};
      const verb = findVerb(part);
      if (verb) action.verb = verb;

      // Try to find object and target in the action
      const toMatch = part.match(/\bto\s+(.+)$/i);
      if (toMatch) {
        const targetPart = toMatch[1].trim();
        const objectPart = part.replace(/\bto\s+.+$/i, "").trim();

        // Target (after "to")
        if (targetPart.match(/\bthat\s+(person|subject|user)\b/i)) {
          action.targetDeterminer = "that";
        } else {
          const targetDet = extractDeterminer(targetPart, targetPart.split(/\s+/).slice(-1)[0]);
          if (targetDet) action.targetDeterminer = targetDet;
          for (const entity of result.entities) {
            if (targetPart.toLowerCase().includes(entity.name.toLowerCase())) {
              const found = findAgent(entity.name);
              if (found) {
                action.targetId = found.id;
                action.targetName = found.name;
                action.targetType = found.type;
              }
              break;
            }
          }
        }

        // Object (before "to")
        for (const entity of result.entities) {
          if (objectPart.toLowerCase().includes(entity.name.toLowerCase())) {
            const found = findResource(entity.name);
            if (found) {
              action.objectId = found.id;
              action.objectName = found.name;
              action.objectType = found.type;
            }
            action.objectDeterminer = extractDeterminer(objectPart, entity.name);
            break;
          }
        }
      } else {
        // No "to" — just look for objects
        for (const entity of result.entities) {
          if (part.toLowerCase().includes(entity.name.toLowerCase())) {
            const found = findResource(entity.name);
            if (found) {
              action.objectId = found.id;
              action.objectName = found.name;
              action.objectType = found.type;
            }
            action.objectDeterminer = extractDeterminer(part, entity.name);
            break;
          }
        }
      }

      if (action.verb) {
        thenActions.push(action);
      }
    }
  } else {
    // No when/then structure — try to parse as a simple action
    const verb = findVerb(lowerInput);
    if (verb) {
      const action: ThenAction = { verb };
      thenActions.push(action);
    }
  }

  // Use V2 conditionals for IF conditions if present
  for (const cond of result.conditionals) {
    if (cond.determiner.toLowerCase() === "if" && !hasIf) {
      hasIf = true;
      const condVerb = findVerb(cond.predicate);
      if (condVerb) ifCondition.verb = condVerb;
    }
  }

  // Default to at least one empty action
  if (thenActions.length === 0) {
    thenActions.push({});
  }

  return { when, thenActions, ifCondition, hasIf };
}
