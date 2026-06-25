"use client";

/**
 * @fileoverview Faceted vault view (Wave 2 / T2.5 UI). Renders the agent's doc
 * Resources as a faceted virtual filesystem — each doc's `metadata.facetedTags`
 * tag-paths place it under multiple orthogonal folder hierarchies at once — and
 * a slide-in parachute-doc editor for the selected doc.
 *
 * The tree comes from `GET /api/agent-hq/faceted-fs`; the editor reads/writes a
 * single Resource via `GET`/`PATCH /api/agent-hq/resources/[id]`. Tags are an
 * overlay/index only: editing tag-paths re-files the doc across facets without
 * touching ownership or visibility (those are separate, owner-gated controls).
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderOpen,
  Loader2,
  Save,
  X,
} from "lucide-react";
import {
  FACET_PATH_SEPARATOR,
  type FacetTreeNode,
} from "@/lib/parachute-doc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FACETED_FS_ENDPOINT = "/api/agent-hq/faceted-fs";
const RESOURCE_ENDPOINT = "/api/agent-hq/resources";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResourceDetail {
  id: string;
  name: string;
  type: string;
  description: string | null;
  content: string | null;
  visibility: string | null;
  tags: string[];
  facetedTags: string[][];
}

interface EditorState {
  name: string;
  content: string;
  /** Tag-paths edited as one materialized path per line. */
  tagsText: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FacetedVaultPanel(): React.ReactElement {
  const [tree, setTree] = useState<FacetTreeNode[]>([]);
  const [docCount, setDocCount] = useState(0);
  const [treeLoading, setTreeLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ResourceDetail | null>(null);
  const [editable, setEditable] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Tree loading
  // -------------------------------------------------------------------------

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
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // -------------------------------------------------------------------------
  // Doc detail / editor
  // -------------------------------------------------------------------------

  const openDoc = useCallback(async (docId: string) => {
    setSelectedDocId(docId);
    setDetailLoading(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`${RESOURCE_ENDPOINT}/${docId}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load doc (${res.status})`);
      }
      const body = (await res.json()) as { resource: ResourceDetail; editable: boolean };
      setDetail(body.resource);
      setEditable(body.editable);
      setEditor({
        name: body.resource.name,
        content: body.resource.content ?? "",
        tagsText: (body.resource.facetedTags ?? [])
          .map((path) => path.join(FACET_PATH_SEPARATOR))
          .join("\n"),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load doc");
      setDetail(null);
      setEditor(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDoc = useCallback(() => {
    setSelectedDocId(null);
    setDetail(null);
    setEditor(null);
    setMessage(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!detail || !editor) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const facetedTags = editor.tagsText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const res = await fetch(`${RESOURCE_ENDPOINT}/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editor.name.trim() || detail.name,
          content: editor.content,
          facetedTags,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to save (${res.status})`);
      }
      const body = (await res.json()) as { resource: ResourceDetail | null };
      if (body.resource) {
        setDetail(body.resource);
        setEditor({
          name: body.resource.name,
          content: body.resource.content ?? "",
          tagsText: (body.resource.facetedTags ?? [])
            .map((path) => path.join(FACET_PATH_SEPARATOR))
            .join("\n"),
        });
      }
      setMessage("Saved.");
      await loadTree();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }, [detail, editor, loadTree]);

  const toggleFolder = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="grid gap-4 md:grid-cols-[300px_1fr]">
      {/* Faceted tree */}
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
          Docs filed by facet. A doc can appear under several hierarchies at once;
          tags are an index, not ownership.
        </p>
        <div className="max-h-[560px] space-y-0.5 overflow-y-auto rounded-md border bg-muted/20 p-2">
          {!treeLoading && tree.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No docs in the vault yet.
            </p>
          ) : (
            <FacetTree
              nodes={tree}
              expanded={expanded}
              selectedDocId={selectedDocId}
              onToggleFolder={toggleFolder}
              onSelectDoc={(docId) => void openDoc(docId)}
            />
          )}
        </div>
        {error && !detailLoading ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>

      {/* Parachute doc editor */}
      <div className="space-y-3 rounded-lg border p-3">
        {!selectedDocId ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Select a doc to view or edit
          </div>
        ) : detailLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : detail && editor ? (
          <>
            <div className="flex items-center justify-between gap-2">
              <Input
                value={editor.name}
                disabled={!editable}
                onChange={(e) => setEditor((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                className="h-8 text-sm font-medium"
              />
              <div className="flex items-center gap-1.5 shrink-0">
                <Badge variant="outline" className="text-[10px]">
                  {detail.visibility ?? "members"}
                </Badge>
                {editable && (
                  <Button
                    size="sm"
                    className="h-8 text-xs gap-1"
                    disabled={saving}
                    onClick={() => void handleSave()}
                  >
                    {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                    Save
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 text-muted-foreground"
                  onClick={closeDoc}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            {!editable && (
              <p className="text-[10px] text-muted-foreground">
                You can view this doc but only its owner can edit it.
              </p>
            )}

            <div className="space-y-1">
              <Label className="text-[10px]">Body (markdown)</Label>
              <textarea
                value={editor.content}
                disabled={!editable}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, content: e.target.value } : prev))
                }
                className="min-h-[420px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs disabled:opacity-70"
                spellCheck={false}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-[10px]">
                Faceted tags — one path per line, e.g. <code>work/projects/rivr</code>
              </Label>
              <textarea
                value={editor.tagsText}
                disabled={!editable}
                onChange={(e) =>
                  setEditor((prev) => (prev ? { ...prev, tagsText: e.target.value } : prev))
                }
                className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs disabled:opacity-70"
                placeholder={"work/projects/rivr\nstatus/draft"}
                spellCheck={false}
              />
              <div className="flex flex-wrap gap-1 pt-1">
                {detail.facetedTags.map((path) => (
                  <Badge
                    key={path.join(FACET_PATH_SEPARATOR)}
                    variant="secondary"
                    className="text-[10px]"
                  >
                    {path.join(FACET_PATH_SEPARATOR)}
                  </Badge>
                ))}
              </div>
            </div>

            {message ? <p className="text-xs text-muted-foreground">{message}</p> : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {error ?? "Failed to load doc"}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Faceted tree renderer
// ---------------------------------------------------------------------------

interface FacetTreeProps {
  nodes: FacetTreeNode[];
  expanded: Set<string>;
  selectedDocId: string | null;
  onToggleFolder: (id: string) => void;
  onSelectDoc: (docId: string) => void;
  depth?: number;
}

function FacetTree({
  nodes,
  expanded,
  selectedDocId,
  onToggleFolder,
  onSelectDoc,
  depth = 0,
}: FacetTreeProps): React.ReactElement | null {
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === "doc") {
          const isSelected = selectedDocId === node.docId;
          return (
            <button
              key={node.id}
              type="button"
              className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted ${
                isSelected ? "bg-primary/10 text-primary" : ""
              }`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => onSelectDoc(node.docId)}
            >
              <span className="inline-block w-3 shrink-0" />
              <FileText className="h-3 w-3 shrink-0" />
              <span className="truncate">{node.name}</span>
            </button>
          );
        }
        const isOpen = expanded.has(node.id);
        return (
          <div key={node.id}>
            <button
              type="button"
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted"
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => onToggleFolder(node.id)}
            >
              {isOpen ? (
                <ChevronDown className="h-3 w-3 shrink-0" />
              ) : (
                <ChevronRight className="h-3 w-3 shrink-0" />
              )}
              <FolderOpen className="h-3 w-3 shrink-0" />
              <span className="truncate">{node.name}</span>
              <span className="ml-auto text-[10px] text-muted-foreground">{node.docCount}</span>
            </button>
            {isOpen && node.children.length > 0 ? (
              <FacetTree
                nodes={node.children}
                expanded={expanded}
                selectedDocId={selectedDocId}
                onToggleFolder={onToggleFolder}
                onSelectDoc={onSelectDoc}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
