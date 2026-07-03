"use client";

/**
 * @fileoverview Faceted vault RAIL — the always-on tag-tree navigator for the
 * personal docs module. The docs surface IS a parachute vault: this rail is the
 * left column, and selecting a facet folder filters the document list on the
 * right (editing/tagging happens in the canonical DocumentViewer, not here).
 *
 * The tree comes from `GET /api/agent-hq/faceted-fs?scope=self` — the person is
 * self-scoped, so its own PRIMARY_AGENT_ID doc Resources form the vault. Each
 * doc's `metadata.facetedTags` tag-paths place it under multiple orthogonal
 * folder hierarchies at once; tags are an overlay/index, not ownership or ACL.
 *
 * Interaction:
 *  - "All docs" clears the facet filter (`onSelectFacet(null)`).
 *  - A folder NAME selects that facet (`onSelectFacet(node.path)`), the chevron
 *    toggles expand. The synthetic "Untagged" folder selects `"__untagged__"`.
 *  - A doc leaf opens the doc (`onOpenDoc(docId)`).
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Inbox,
  Loader2,
} from "lucide-react";
import {
  UNTAGGED_FACET_LABEL,
  type FacetTreeNode,
} from "@/lib/parachute-doc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACETED_FS_ENDPOINT = "/api/agent-hq/faceted-fs";

/** Sentinel facet value for the synthetic "Untagged" bucket. */
export const UNTAGGED_FACET_VALUE = "__untagged__";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface FacetedVaultPanelProps {
  /**
   * The self-scoped owner whose docs form the vault. The person endpoint is
   * self-scoped (PRIMARY_AGENT_ID via `scope=self`); this drives a refetch when
   * the viewed owner changes.
   */
  ownerId?: string;
  /** Called with a document id when a doc leaf is selected. */
  onOpenDoc: (docId: string) => void;
  /** Called with the selected facet path, `UNTAGGED_FACET_VALUE`, or `null` for all docs. */
  onSelectFacet: (facet: string | null) => void;
  /** The currently selected facet (`null` = all docs). */
  selectedFacet: string | null;
}

export function FacetedVaultPanel({
  ownerId,
  onOpenDoc,
  onSelectFacet,
  selectedFacet,
}: FacetedVaultPanelProps): React.ReactElement {
  const [tree, setTree] = useState<FacetTreeNode[]>([]);
  const [docCount, setDocCount] = useState(0);
  const [treeLoading, setTreeLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    setError(null);
    try {
      const res = await fetch(`${FACETED_FS_ENDPOINT}?scope=self`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load vault (${res.status})`);
      }
      const body = (await res.json()) as { tree: FacetTreeNode[]; docCount: number };
      setTree(body.tree);
      setDocCount(body.docCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vault");
    } finally {
      setTreeLoading(false);
    }
    // `ownerId` participates so a change of viewed owner refetches the vault.
  }, [ownerId]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium text-muted-foreground">Vault</p>
          {treeLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <Badge variant="secondary" className="text-[10px]">
          {docCount} {docCount === 1 ? "doc" : "docs"}
        </Badge>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Your docs filed by facet. A doc can appear under several nested-tag
        hierarchies at once; tags are an index, not ownership.
      </p>
      <div className="max-h-[560px] space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-2">
        {/* "All docs" clears the facet filter. */}
        <button
          type="button"
          className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted ${
            selectedFacet === null ? "bg-primary/10 text-primary" : ""
          }`}
          onClick={() => onSelectFacet(null)}
        >
          <Inbox className="h-3 w-3 shrink-0" />
          <span className="truncate font-medium">All docs</span>
          <span className="ml-auto text-[10px] text-muted-foreground">{docCount}</span>
        </button>

        {!treeLoading && tree.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            No docs in the vault yet.
          </p>
        ) : (
          <FacetTree
            nodes={tree}
            expanded={expanded}
            selectedFacet={selectedFacet}
            onToggleFolder={toggleFolder}
            onSelectFacet={onSelectFacet}
            onOpenDoc={onOpenDoc}
          />
        )}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faceted tree renderer
// ---------------------------------------------------------------------------

/**
 * Maps a facet folder node to the filter value it selects. The synthetic
 * "Untagged" top-level bucket (name/path === {@link UNTAGGED_FACET_LABEL})
 * resolves to {@link UNTAGGED_FACET_VALUE}; every other folder selects its own
 * materialized path.
 */
function facetValueForNode(path: string): string {
  return path === UNTAGGED_FACET_LABEL ? UNTAGGED_FACET_VALUE : path;
}

interface FacetTreeProps {
  nodes: FacetTreeNode[];
  expanded: Set<string>;
  selectedFacet: string | null;
  onToggleFolder: (id: string) => void;
  onSelectFacet: (facet: string | null) => void;
  onOpenDoc: (docId: string) => void;
  depth?: number;
}

function FacetTree({
  nodes,
  expanded,
  selectedFacet,
  onToggleFolder,
  onSelectFacet,
  onOpenDoc,
  depth = 0,
}: FacetTreeProps): React.ReactElement | null {
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === "doc") {
          return (
            <button
              key={node.id}
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted"
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => onOpenDoc(node.docId)}
            >
              <span className="inline-block w-3 shrink-0" />
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
          );
        }
        const isOpen = expanded.has(node.id);
        const facetValue = facetValueForNode(node.path);
        const isSelected = selectedFacet === facetValue;
        return (
          <div key={node.id}>
            <div
              className={`flex w-full items-center gap-1 rounded text-xs ${
                isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted"
              }`}
              style={{ paddingLeft: `${4 + depth * 12}px` }}
            >
              {/* Chevron toggles expand without changing the facet filter. */}
              <button
                type="button"
                aria-label={isOpen ? `Collapse ${node.name}` : `Expand ${node.name}`}
                className="rounded p-0.5 hover:bg-muted"
                onClick={() => onToggleFolder(node.id)}
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
              </button>
              {/* Folder name selects this facet as the active filter. */}
              <button
                type="button"
                className="flex flex-1 items-center gap-1.5 rounded px-1 py-1 text-left"
                onClick={() => onSelectFacet(facetValue)}
              >
                <FolderOpen className="h-3 w-3 shrink-0" />
                <span className="truncate">{node.name}</span>
                <span className="ml-auto pl-1 text-[10px] text-muted-foreground">
                  {node.docCount}
                </span>
              </button>
            </div>
            {isOpen && node.children.length > 0 ? (
              <FacetTree
                nodes={node.children}
                expanded={expanded}
                selectedFacet={selectedFacet}
                onToggleFolder={onToggleFolder}
                onSelectFacet={onSelectFacet}
                onOpenDoc={onOpenDoc}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
