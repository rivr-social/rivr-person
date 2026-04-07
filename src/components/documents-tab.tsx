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
import { useEffect, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import type { Document } from "@/types/domain"
import { DocumentList } from "./document-list"
import { DocumentViewer } from "./document-viewer"
import { EmptyState } from "./empty-state"
import { FileText } from "lucide-react"
import { createDocumentResourceAction, createPersonalDocumentAction } from "@/app/actions/create-resources"
import { useToast } from "@/components/ui/use-toast"

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
  const [documentItems, setDocumentItems] = useState<Document[]>(documents)
  const [selectedDocument, setSelectedDocument] = useState<Document | null>(null)

  useEffect(() => {
    setDocumentItems(documents)
  }, [documents])

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
  if (scopedDocuments.length === 0) {
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
  )
}
