"use client";

/**
 * Scope picker for builder REA data sources (rivr-agents / rivr-ledger /
 * rivr-resources).
 *
 * Lets the user declare WHAT the built site may read from their own Agents /
 * Ledger / Resources:
 *   - KINDS: toggle chips drawn from the source's scope vocabulary
 *     (resource types, agent types, or ledger verb types).
 *   - SPECIFIC OBJECTS: a searchable multi-select of concrete agents/resources.
 *
 * The selection is stored on the data-source binding's config as
 * `{ scopeTypes, scopeIds }` and enforced server-side by
 * `/api/builder/rea-source` (which can only ever NARROW what the owner can
 * already view). This component authors scope; it does not grant access.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Search, X } from "lucide-react";
import {
  fetchAgentsForComposer,
  fetchResourcesForComposer,
} from "@/app/actions/graph";
import { scopeVocabularyCatalog } from "@/lib/bespoke/rea-scope-vocab";
import type { DataSourceConfig } from "@/lib/bespoke/types";
import type { DataSourceMeta } from "@/lib/bespoke/data-source-registry";

interface ObjectOption {
  id: string;
  name: string;
  type: string;
}

interface BuilderReaScopePickerProps {
  vocabulary: NonNullable<DataSourceMeta["scopeVocabulary"]>;
  config: DataSourceConfig;
  onChange: (next: DataSourceConfig) => void;
}

export function BuilderReaScopePicker({
  vocabulary,
  config,
  onChange,
}: BuilderReaScopePickerProps) {
  const scopeTypes = useMemo(() => config.scopeTypes ?? [], [config.scopeTypes]);
  const scopeIds = useMemo(() => config.scopeIds ?? [], [config.scopeIds]);

  const catalog = useMemo(() => scopeVocabularyCatalog(vocabulary), [vocabulary]);

  const [objectQuery, setObjectQuery] = useState("");
  const [objects, setObjects] = useState<ObjectOption[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);

  // For agents → fetch agents; for resources → fetch resources; for ledger the
  // specific ids reference either side of the triple, so offer both catalogs.
  const loadObjects = useCallback(async () => {
    setObjectsLoading(true);
    try {
      const results: ObjectOption[] = [];
      if (vocabulary === "agent-types" || vocabulary === "verb-types") {
        const agentRows = await fetchAgentsForComposer();
        results.push(...agentRows.map((a) => ({ id: a.id, name: a.name, type: a.type })));
      }
      if (vocabulary === "resource-types" || vocabulary === "verb-types") {
        const resourceRows = await fetchResourcesForComposer();
        results.push(
          ...resourceRows.map((r) => ({ id: r.id, name: r.title, type: r.type })),
        );
      }
      setObjects(results);
    } catch (err) {
      console.error("[BuilderReaScopePicker] loadObjects failed:", err);
    } finally {
      setObjectsLoading(false);
    }
  }, [vocabulary]);

  useEffect(() => {
    void loadObjects();
  }, [loadObjects]);

  const toggleType = useCallback(
    (type: string) => {
      const next = scopeTypes.includes(type)
        ? scopeTypes.filter((t) => t !== type)
        : [...scopeTypes, type];
      onChange({ ...config, scopeTypes: next });
    },
    [config, onChange, scopeTypes],
  );

  const toggleObject = useCallback(
    (id: string) => {
      const next = scopeIds.includes(id)
        ? scopeIds.filter((i) => i !== id)
        : [...scopeIds, id];
      onChange({ ...config, scopeIds: next });
    },
    [config, onChange, scopeIds],
  );

  const filteredObjects = useMemo(() => {
    const q = objectQuery.trim().toLowerCase();
    if (!q) return objects.slice(0, 50);
    return objects
      .filter(
        (o) =>
          o.name.toLowerCase().includes(q) || o.type.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [objects, objectQuery]);

  const selectedObjects = useMemo(
    () => objects.filter((o) => scopeIds.includes(o.id)),
    [objects, scopeIds],
  );

  const noFilter = scopeTypes.length === 0 && scopeIds.length === 0;

  return (
    <div className="space-y-3 pt-1">
      {/* Kind chips */}
      <div className="space-y-1.5">
        <Label>Kinds</Label>
        <div className="flex flex-wrap gap-1">
          {catalog.map((type) => {
            const active = scopeTypes.includes(type);
            return (
              <button
                key={type}
                type="button"
                onClick={() => toggleType(type)}
                className={`text-[10px] rounded px-1.5 py-0.5 border transition-colors ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-transparent text-muted-foreground border-border hover:text-foreground"
                }`}
              >
                {type}
              </button>
            );
          })}
        </div>
      </div>

      {/* Specific objects */}
      <div className="space-y-1.5">
        <Label>Specific objects</Label>
        {selectedObjects.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedObjects.map((o) => (
              <Badge key={o.id} variant="secondary" className="text-[10px] gap-1">
                {o.name}
                <button type="button" onClick={() => toggleObject(o.id)}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            className="h-7 text-xs pl-7"
            placeholder="Search to add specific items…"
            value={objectQuery}
            onChange={(e) => setObjectQuery(e.target.value)}
          />
          {objectsLoading && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        {objectQuery.trim().length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded border divide-y">
            {filteredObjects.length === 0 ? (
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground">
                No matches
              </div>
            ) : (
              filteredObjects.map((o) => {
                const selected = scopeIds.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => toggleObject(o.id)}
                    className={`flex items-center justify-between w-full px-2 py-1.5 text-left text-[10px] hover:bg-muted ${
                      selected ? "bg-muted" : ""
                    }`}
                  >
                    <span className="truncate">{o.name}</span>
                    <Badge variant="outline" className="text-[9px] ml-2 shrink-0">
                      {o.type}
                    </Badge>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {noFilter && (
        <p className="text-[10px] text-amber-600">
          No scope set — the built site may read everything you can view of this
          table. Add kinds or specific objects to narrow it.
        </p>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[10px] font-medium block">{children}</span>;
}
