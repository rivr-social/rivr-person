"use client"

/**
 * Documents Tab container for the document feature.
 *
 * Used in:
 * - Group detail page/tab where users browse and open documents tied to a specific group.
 * - Profile page/tab where users browse and manage personal documents.
 *
 * Key props:
 * - `groupId`: (optional) Identifier used to scope the document list to a single group.
 * - `ownerId`: (optional) Identifier used to scope the document list to a user's personal docs.
 * - `documents`: Pre-fetched documents (from server component parent or client fetch).
 *
 * Supply either `groupId` (group documents) or `ownerId` (personal documents), not both.
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { Document } from "@/types/domain"
import { DocumentList } from "./document-list"
import { DocumentViewer } from "./document-viewer"
import { EmptyState } from "./empty-state"
import { ChevronDown, ChevronRight, FileText, FolderOpen } from "lucide-react"
import { createDocumentResourceAction, createPersonalDocumentAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type DocViewMode = "documents" | "filesystem"

interface FsWorkspace {
  id: string
  label: string
  cwd: string
  scope: "foundation" | "app" | "shared"
}

interface FsEntry {
  name: string
  path: string
  type: "file" | "directory"
  size: number
}
interface ExplorerNode extends FsEntry {
  id: string
  source: "fs" | "db"
  expanded?: boolean
  loaded?: boolean
  loading?: boolean
  children?: ExplorerNode[]
}

interface DocumentsTabProps {
  /** Group identifier for group-scoped documents. */
  groupId?: string
  /** User agent identifier for personal documents. */
  ownerId?: string
  documents: Document[]
  docsPath: string
}

/**
 * Controls document list vs. document detail rendering for a group or user.
 *
 * @param props Component props.
 * @param props.groupId Group identifier used to filter group documents.
 * @param props.ownerId User identifier used for personal documents.
 * @param props.documents Pre-fetched document array.
 * @returns Empty state, document list, or selected document viewer depending on current state/data.
 */
export function DocumentsTab({ groupId, ownerId, documents, docsPath }: DocumentsTabProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const isPersonal = !groupId && !!ownerId
  const [viewMode, setViewMode] = useState<DocViewMode>("filesystem")
  const [documentItems, setDocumentItems] = useState<Document[]>(documents)
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null)
  const [fsWorkspaces, setFsWorkspaces] = useState<FsWorkspace[]>([])
  const [fsWorkspaceId, setFsWorkspaceId] = useState("")
  const [fsRootPath, setFsRootPath] = useState("")
  const [fsTree, setFsTree] = useState<ExplorerNode[]>([])
  const [dbTree, setDbTree] = useState<ExplorerNode[]>([])
  const [fsLoading, setFsLoading] = useState(false)
  const [fsError, setFsError] = useState<string | null>(null)
  const [fsSelectedFile, setFsSelectedFile] = useState<string>("")
  const [fsFileContent, setFsFileContent] = useState("")
  const [fsFileLoading, setFsFileLoading] = useState(false)
  const [fsFileSaving, setFsFileSaving] = useState(false)
  const [fsMessage, setFsMessage] = useState<string | null>(null)

  useEffect(() => {
    setDocumentItems(documents)
  }, [documents])

  const fetchFsEntries = useCallback(async (workspaceId: string, nextPath: string) => {
    try {
      const params = new URLSearchParams()
      if (nextPath) params.set("path", nextPath)
      const response = await fetch(
        `/api/agent-hq/workspaces/${encodeURIComponent(workspaceId)}/entries?${params.toString()}`,
        { cache: "no-store" },
      )
      const data = (await response.json().catch(() => ({}))) as {
        entries?: FsEntry[]
        relativePath?: string
        error?: string
      }
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load files (${response.status})`)
      }
      return {
        entries: data.entries ?? [],
        relativePath: data.relativePath ?? nextPath,
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Failed to load filesystem entries")
    }
  }, [])

  const sortFsEntries = useCallback((entries: FsEntry[]) => {
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [])

  const toTreeNodes = useCallback(
    (entries: FsEntry[], source: "fs" | "db"): ExplorerNode[] =>
      sortFsEntries(entries).map((entry) => ({ ...entry, id: `${source}:${entry.path}`, source })),
    [sortFsEntries],
  )

  const updateTreeNode = useCallback(
    (
      nodes: ExplorerNode[],
      targetId: string,
      updater: (node: ExplorerNode) => ExplorerNode,
    ): ExplorerNode[] =>
      nodes.map((node) => {
        if (node.id === targetId) {
          return updater(node)
        }
        if (node.children && node.children.length > 0) {
          return { ...node, children: updateTreeNode(node.children, targetId, updater) }
        }
        return node
      }),
    [],
  )

  const loadFsTreeRoot = useCallback(
    async (workspaceId: string, rootPath: string) => {
      if (!workspaceId) return
      setFsLoading(true)
      setFsError(null)
      try {
        const result = await fetchFsEntries(workspaceId, rootPath)
        setFsRootPath(result.relativePath)
        setFsTree(toTreeNodes(result.entries, "fs"))
      } catch (error) {
        setFsError(error instanceof Error ? error.message : "Failed to load filesystem entries")
      } finally {
        setFsLoading(false)
      }
    },
    [fetchFsEntries, toTreeNodes],
  )

  const toggleFsDirectory = useCallback(
    async (node: ExplorerNode) => {
      if (!fsWorkspaceId || node.type !== "directory" || node.source !== "fs") return
      const isExpanded = Boolean(node.expanded)
      if (isExpanded) {
        setFsTree((current) =>
          updateTreeNode(current, node.id, (entry) => ({ ...entry, expanded: false })),
        )
        return
      }

      if (node.loaded) {
        setFsTree((current) =>
          updateTreeNode(current, node.id, (entry) => ({ ...entry, expanded: true })),
        )
        return
      }

      setFsTree((current) =>
        updateTreeNode(current, node.id, (entry) => ({
          ...entry,
          expanded: true,
          loading: true,
        })),
      )
      try {
        const result = await fetchFsEntries(fsWorkspaceId, node.path)
        const children = toTreeNodes(result.entries, "fs")
        setFsTree((current) =>
          updateTreeNode(current, node.id, (entry) => ({
            ...entry,
            expanded: true,
            loading: false,
            loaded: true,
            children,
          })),
        )
      } catch (error) {
        setFsError(error instanceof Error ? error.message : "Failed to load directory")
        setFsTree((current) =>
          updateTreeNode(current, node.id, (entry) => ({ ...entry, loading: false })),
        )
      }
    },
    [fetchFsEntries, fsWorkspaceId, toTreeNodes, updateTreeNode],
  )

  const loadFsFile = useCallback(async (workspaceId: string, path: string) => {
    if (!workspaceId || !path) return
    setFsFileLoading(true)
    setFsMessage(null)
    try {
      const params = new URLSearchParams({ path })
      const response = await fetch(
        `/api/agent-hq/workspaces/${encodeURIComponent(workspaceId)}/file?${params.toString()}`,
        { cache: "no-store" },
      )
      const data = (await response.json().catch(() => ({}))) as { content?: string; error?: string }
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load file (${response.status})`)
      }
      setFsSelectedFile(path)
      setFsFileContent(data.content ?? "")
      setFsMessage(`Loaded ${path}`)
    } catch (error) {
      setFsMessage(error instanceof Error ? error.message : "Failed to load file")
    } finally {
      setFsFileLoading(false)
    }
  }, [])

  const fetchDbEntries = useCallback(async (nextPath: string) => {
    const params = new URLSearchParams()
    if (nextPath) params.set("path", nextPath)
    const response = await fetch(`/api/agent-hq/db/entries?${params.toString()}`, { cache: "no-store" })
    const data = (await response.json().catch(() => ({}))) as {
      entries?: FsEntry[]
      relativePath?: string
      error?: string
    }
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to load DB entries (${response.status})`)
    }
    return {
      entries: data.entries ?? [],
      relativePath: data.relativePath ?? nextPath,
    }
  }, [])

  const loadDbRoot = useCallback(async () => {
    try {
      const result = await fetchDbEntries("")
      setDbTree(toTreeNodes(result.entries, "db"))
    } catch (error) {
      setFsError(error instanceof Error ? error.message : "Failed to load database tree")
    }
  }, [fetchDbEntries, toTreeNodes])

  const toggleDbDirectory = useCallback(
    async (node: ExplorerNode) => {
      if (node.type !== "directory" || node.source !== "db") return
      if (node.expanded) {
        setDbTree((current) => updateTreeNode(current, node.id, (entry) => ({ ...entry, expanded: false })))
        return
      }
      if (node.loaded) {
        setDbTree((current) => updateTreeNode(current, node.id, (entry) => ({ ...entry, expanded: true })))
        return
      }
      setDbTree((current) =>
        updateTreeNode(current, node.id, (entry) => ({ ...entry, expanded: true, loading: true })),
      )
      try {
        const result = await fetchDbEntries(node.path)
        const children = toTreeNodes(result.entries, "db")
        setDbTree((current) =>
          updateTreeNode(current, node.id, (entry) => ({
            ...entry,
            expanded: true,
            loading: false,
            loaded: true,
            children,
          })),
        )
      } catch (error) {
        setFsError(error instanceof Error ? error.message : "Failed to load database directory")
        setDbTree((current) => updateTreeNode(current, node.id, (entry) => ({ ...entry, loading: false })))
      }
    },
    [fetchDbEntries, toTreeNodes, updateTreeNode],
  )

  const loadDbFile = useCallback(async (path: string) => {
    if (!path) return
    setFsFileLoading(true)
    setFsMessage(null)
    try {
      const params = new URLSearchParams({ path })
      const response = await fetch(`/api/agent-hq/db/file?${params.toString()}`, { cache: "no-store" })
      const data = (await response.json().catch(() => ({}))) as { content?: string; error?: string }
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load DB file (${response.status})`)
      }
      setFsSelectedFile(`db:${path}`)
      setFsFileContent(data.content ?? "")
      setFsMessage(`Loaded ${path}`)
    } catch (error) {
      setFsMessage(error instanceof Error ? error.message : "Failed to load database file")
    } finally {
      setFsFileLoading(false)
    }
  }, [])

  useEffect(() => {
    if (viewMode !== "filesystem") return
    let cancelled = false
    async function loadWorkspaces() {
      try {
        const response = await fetch("/api/agent-hq/launchers", { cache: "no-store" })
        const data = (await response.json().catch(() => ({}))) as {
          workspaces?: FsWorkspace[]
          error?: string
        }
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to load workspaces (${response.status})`)
        }
        if (cancelled) return
        const workspaces = data.workspaces ?? []
        setFsWorkspaces(workspaces)
        const initialWorkspaceId = workspaces.find((entry) => entry.scope === "app")?.id ?? workspaces[0]?.id ?? ""
        setFsWorkspaceId((current) => current || initialWorkspaceId)
      } catch (error) {
        if (!cancelled) {
          setFsError(error instanceof Error ? error.message : "Failed to load workspaces")
        }
      }
    }
    void loadWorkspaces()
    return () => {
      cancelled = true
    }
  }, [viewMode])

  useEffect(() => {
    if (viewMode !== "filesystem" || !fsWorkspaceId) return
    void loadFsTreeRoot(fsWorkspaceId, "")
  }, [fsWorkspaceId, loadFsTreeRoot, viewMode])

  useEffect(() => {
    if (viewMode !== "filesystem") return
    void loadDbRoot()
  }, [loadDbRoot, viewMode])

  const handleCreateDocument = () => {
    startTransition(async () => {
      const result = isPersonal
        ? await createPersonalDocumentAction({ title: "New Document", content: "" })
        : await createDocumentResourceAction({ groupId: groupId!, title: "New Document", content: "" })

      if (result.success && result.resourceId) {
        toast({ title: "Document created", description: "Your new document is ready." })
        router.push(`${docsPath}?doc=${result.resourceId}`)
      } else {
        toast({ title: "Failed to create document", description: result.message, variant: "destructive" })
      }
    })
  }

  // Data derivation: filters to only documents that belong to the active scope.
  const scopedDocuments = isPersonal
    ? documentItems.filter(doc => doc.ownerId === ownerId)
    : documentItems.filter(doc => doc.groupId === groupId)

  const selectedFileDisplay = useMemo(() => {
    if (!fsSelectedFile) return ""
    if (fsSelectedFile.startsWith("db:")) {
      return fsSelectedFile.slice(3)
    }
    return fsSelectedFile
  }, [fsSelectedFile])

  const explorerRoots = useMemo<ExplorerNode[]>(
    () => [
      {
        id: "db:__root__",
        source: "db",
        name: "Database",
        path: "",
        type: "directory",
        expanded: true,
        loaded: true,
        children: dbTree,
        size: 0,
      },
      {
        id: "fs:__root__",
        source: "fs",
        name: "Filesystem",
        path: "",
        type: "directory",
        expanded: true,
        loaded: true,
        children: fsTree,
        size: 0,
      },
    ],
    [dbTree, fsTree],
  )

  useEffect(() => {
    const currentDocId = searchParams.get("doc")
    if (!currentDocId) {
      setSelectedDocument(null)
      return
    }

    const nextDocument = scopedDocuments.find((document) => document.id === currentDocId) ?? null
    setSelectedDocument(nextDocument)
  }, [scopedDocuments, searchParams])

  const emptyDescription = isPersonal
    ? "You don't have any personal documents yet. Create the first one to get started."
    : "This group doesn't have any documents yet. Create the first one to get started."

  // Conditional rendering: show empty state when no documents exist for the scope.
  if (viewMode === "documents" && scopedDocuments.length === 0) {
    return (
      <EmptyState
        title="No Documents Yet"
        description={emptyDescription}
        action={{
          label: isPending ? "Creating..." : "Create Document",
          onClick: handleCreateDocument,
        }}
        icon={<FileText className="h-12 w-12" />}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant={viewMode === "documents" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("documents")}
        >
          Documents
        </Button>
        <Button
          variant={viewMode === "filesystem" ? "default" : "outline"}
          size="sm"
          onClick={() => setViewMode("filesystem")}
        >
          Filesystem
        </Button>
      </div>

      {viewMode === "filesystem" ? (
        <div className="grid gap-4 md:grid-cols-[300px_1fr]">
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Workspace</p>
              <select
                value={fsWorkspaceId}
                onChange={(event) => {
                  setFsWorkspaceId(event.target.value)
                  setFsSelectedFile("")
                  setFsFileContent("")
                  setFsMessage(null)
                  setFsTree([])
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              >
                {fsWorkspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.label} · {workspace.scope}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-muted-foreground">Root</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => void loadFsTreeRoot(fsWorkspaceId, fsRootPath)}
                  disabled={fsLoading || !fsWorkspaceId}
                >
                  Refresh
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  value={fsRootPath || "/"}
                  onChange={(event) => setFsRootPath(event.target.value === "/" ? "" : event.target.value)}
                  className="h-8 text-xs"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => void loadFsTreeRoot(fsWorkspaceId, fsRootPath)}
                  disabled={fsLoading || !fsWorkspaceId}
                >
                  Open
                </Button>
              </div>
            </div>
            <div className="max-h-[520px] space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2">
              <FilesystemTree
                nodes={explorerRoots}
                selectedFile={fsSelectedFile}
                onToggleDirectory={(node) => {
                  if (node.id === "db:__root__" || node.id === "fs:__root__") return
                  if (node.source === "db") {
                    void toggleDbDirectory(node)
                    return
                  }
                  void toggleFsDirectory(node)
                }}
                onSelectFile={(node) => {
                  if (node.source === "db") {
                    void loadDbFile(node.path)
                    return
                  }
                  void loadFsFile(fsWorkspaceId, node.path)
                }}
              />
              {!fsLoading && fsTree.length === 0 && dbTree.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">No files in this tree.</p>
              ) : null}
            </div>
            {fsError ? <p className="text-xs text-destructive">{fsError}</p> : null}
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{selectedFileDisplay || "Select a file"}</p>
              <Button
                size="sm"
                onClick={async () => {
                  if (!fsSelectedFile) return
                  setFsFileSaving(true)
                  setFsMessage(null)
                  try {
                    const isDbFile = fsSelectedFile.startsWith("db:")
                    const selectedPath = isDbFile ? fsSelectedFile.slice(3) : fsSelectedFile
                    const response = await fetch(
                      isDbFile
                        ? "/api/agent-hq/db/file"
                        : `/api/agent-hq/workspaces/${encodeURIComponent(fsWorkspaceId)}/file`,
                      {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: selectedPath, content: fsFileContent }),
                      },
                    )
                    const data = (await response.json().catch(() => ({}))) as { error?: string }
                    if (!response.ok || data.error) {
                      throw new Error(data.error || `Failed to save file (${response.status})`)
                    }
                    setFsMessage(`Saved ${selectedPath}`)
                  } catch (error) {
                    setFsMessage(error instanceof Error ? error.message : "Failed to save file")
                  } finally {
                    setFsFileSaving(false)
                  }
                }}
                disabled={!fsSelectedFile || fsFileSaving}
              >
                {fsFileSaving ? "Saving..." : "Save"}
              </Button>
            </div>
            <textarea
              value={fsFileContent}
              onChange={(event) => setFsFileContent(event.target.value)}
              className="min-h-[560px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              placeholder={fsFileLoading ? "Loading..." : "Open a file from the left pane."}
              spellCheck={false}
            />
            {fsMessage ? <p className="text-xs text-muted-foreground">{fsMessage}</p> : null}
          </div>
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-[320px_1fr]">
          <DocumentList
            documents={scopedDocuments}
            groupId={groupId}
            ownerId={ownerId}
            onCreateDocument={handleCreateDocument}
            documentHrefBuilder={(doc) => `${docsPath}?doc=${doc.id}`}
          />

          {selectedDocument ? (
            <DocumentViewer
              document={selectedDocument}
              onBack={() => router.push(docsPath)}
              onDocumentUpdated={(nextDocument) => {
                setDocumentItems((current) => current.map((document) => document.id === nextDocument.id ? nextDocument : document))
                setSelectedDocument(nextDocument)
              }}
              kgScopeType={isPersonal ? "person" : "group"}
              kgScopeId={isPersonal ? ownerId : groupId}
              canPushToKg={isPersonal}
            />
          ) : (
            <div className="flex items-center justify-center rounded-lg border text-muted-foreground">
              Select a document to preview
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface FilesystemTreeProps {
  nodes: ExplorerNode[]
  selectedFile: string
  onToggleDirectory: (node: ExplorerNode) => void
  onSelectFile: (node: ExplorerNode) => void
  depth?: number
}

function FilesystemTree({
  nodes,
  selectedFile,
  onToggleDirectory,
  onSelectFile,
  depth = 0,
}: FilesystemTreeProps) {
  if (nodes.length === 0) return null
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const isDirectory = node.type === "directory"
        const nodeSelectionValue = node.source === "db" ? `db:${node.path}` : node.path
        const isSelected = !isDirectory && selectedFile === nodeSelectionValue
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-muted ${isSelected ? "bg-primary/10 text-primary" : ""}`}
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(node)
                  return
                }
                onSelectFile(node)
              }}
            >
              {isDirectory ? (
                node.expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
              ) : (
                <span className="inline-block w-3 shrink-0" />
              )}
              {isDirectory ? <FolderOpen className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
              <span className="truncate">{node.name}</span>
              {node.loading ? <span className="ml-auto text-[10px] text-muted-foreground">…</span> : null}
            </button>
            {isDirectory && node.expanded && node.children && node.children.length > 0 ? (
              <FilesystemTree
                nodes={node.children}
                selectedFile={selectedFile}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                depth={depth + 1}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
