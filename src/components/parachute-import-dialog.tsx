"use client";

/**
 * @fileoverview Parachute vault import dialog (person-app / camalot owner).
 *
 * Two ingress paths, both reducing to `POST /api/agent-hq/parachute-import`:
 *   1. Upload folder — a `webkitdirectory` picker hands us the whole vault directory
 *      with each file's relative path preserved (that path IS the vault hierarchy).
 *      Markdown/text notes are read client-side and POSTed as `{ path, content }[]`.
 *      No zip dependency.
 *   2. Connect daemon — a running Parachute daemon (`GET /notes`, `Bearer pvt_…`) is
 *      pulled server-side.
 *
 * On success the dialog reports the per-file `{ created, updated, skipped }` summary
 * and invokes `onImported()` so the caller can refresh the faceted tree. Tags remain
 * an overlay/index — this dialog imports docs, it does not touch ownership or ACL.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, UploadCloud, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const IMPORT_ENDPOINT = "/api/agent-hq/parachute-import";
const ALLOWED_EXTENSIONS = [".md", ".markdown", ".txt"];

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  message: string;
}

interface ParachuteImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful import so the caller can refresh its view. */
  onImported?: () => void;
}

type ImportTab = "upload" | "daemon";

function isMarkdownLike(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function ParachuteImportDialog({
  open,
  onOpenChange,
  onImported,
}: ParachuteImportDialogProps): React.ReactElement {
  const [tab, setTab] = useState<ImportTab>("upload");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [daemonUrl, setDaemonUrl] = useState("http://127.0.0.1:1940");
  const [daemonToken, setDaemonToken] = useState("");
  const [daemonVault, setDaemonVault] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // React/TS has no typed `webkitdirectory` prop — set it on the DOM node directly.
  useEffect(() => {
    const node = folderInputRef.current;
    if (node) {
      node.setAttribute("webkitdirectory", "");
      node.setAttribute("directory", "");
    }
  }, []);

  // Reset transient state whenever the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setError(null);
      setSummary(null);
    }
  }, [open]);

  const handleFolderPick = useCallback((fileList: FileList | null) => {
    setError(null);
    setSummary(null);
    if (!fileList) {
      setSelectedFiles([]);
      return;
    }
    const markdown = Array.from(fileList).filter((file) => isMarkdownLike(file.name));
    setSelectedFiles(markdown);
  }, []);

  const runUploadImport = useCallback(async () => {
    if (selectedFiles.length === 0) {
      setError("Pick a vault folder with at least one .md note.");
      return;
    }
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const files = await Promise.all(
        selectedFiles.map(async (file) => ({
          // webkitRelativePath is the in-vault path (folder hierarchy + filename).
          path: file.webkitRelativePath || file.name,
          content: await file.text(),
        })),
      );
      const res = await fetch(IMPORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "files", files }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | ImportSummary & { success: true }
        | { success?: false; error?: string };
      if (!res.ok || !("success" in data) || !data.success) {
        throw new Error(
          ("error" in data && data.error) || `Import failed (${res.status})`,
        );
      }
      setSummary(data);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }, [selectedFiles, onImported]);

  const runDaemonImport = useCallback(async () => {
    if (!daemonUrl.trim() || !daemonToken.trim()) {
      setError("A daemon URL and pvt_ token are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const res = await fetch(IMPORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "daemon",
          url: daemonUrl.trim(),
          token: daemonToken.trim(),
          ...(daemonVault.trim() ? { vaultName: daemonVault.trim() } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | ImportSummary & { success: true }
        | { success?: false; error?: string };
      if (!res.ok || !("success" in data) || !data.success) {
        throw new Error(
          ("error" in data && data.error) || `Import failed (${res.status})`,
        );
      }
      setSummary(data);
      onImported?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }, [daemonUrl, daemonToken, daemonVault, onImported]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader className="relative z-[4]">
          <DialogTitle>Import Parachute vault</DialogTitle>
          <DialogDescription>
            Import a Parachute / Obsidian markdown vault. Folder structure and nested
            <code className="mx-1 rounded bg-muted px-1 py-0.5 text-[11px]">#tags</code>
            become faceted tag-paths. Imported notes are private.
          </DialogDescription>
        </DialogHeader>

        <div className="relative z-[4] flex items-center gap-2">
          <Button
            type="button"
            variant={tab === "upload" ? "default" : "outline"}
            size="sm"
            className="gap-1"
            onClick={() => setTab("upload")}
          >
            <UploadCloud className="h-3.5 w-3.5" />
            Upload folder
          </Button>
          <Button
            type="button"
            variant={tab === "daemon" ? "default" : "outline"}
            size="sm"
            className="gap-1"
            onClick={() => setTab("daemon")}
          >
            <Radio className="h-3.5 w-3.5" />
            Connect daemon
          </Button>
        </div>

        {tab === "upload" ? (
          <div className="relative z-[4] space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Vault folder</Label>
              <input
                ref={folderInputRef}
                type="file"
                multiple
                accept=".md,.markdown,.txt"
                className="block w-full cursor-pointer rounded-md border border-input bg-background/60 text-xs file:mr-3 file:cursor-pointer file:border-0 file:bg-muted file:px-3 file:py-2 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/70"
                onChange={(event) => handleFolderPick(event.target.files)}
              />
              <p className="text-[11px] text-muted-foreground">
                {selectedFiles.length > 0
                  ? `${selectedFiles.length} markdown note${selectedFiles.length === 1 ? "" : "s"} ready to import.`
                  : "Choose the vault directory — every .md / .txt note inside is imported."}
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                className="gap-1"
                disabled={busy || selectedFiles.length === 0}
                onClick={() => void runUploadImport()}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                Import {selectedFiles.length > 0 ? `${selectedFiles.length} notes` : "vault"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="relative z-[4] space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Daemon URL</Label>
              <Input
                value={daemonUrl}
                onChange={(event) => setDaemonUrl(event.target.value)}
                placeholder="http://127.0.0.1:1940"
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">API token</Label>
              <Input
                type="password"
                value={daemonToken}
                onChange={(event) => setDaemonToken(event.target.value)}
                placeholder="pvt_…"
                className="h-9 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Vault name (optional)</Label>
              <Input
                value={daemonVault}
                onChange={(event) => setDaemonVault(event.target.value)}
                placeholder="default"
                className="h-9 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">
                Leave blank to pull the daemon&apos;s default vault.
              </p>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                className="gap-1"
                disabled={busy || !daemonUrl.trim() || !daemonToken.trim()}
                onClick={() => void runDaemonImport()}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
                Pull vault
              </Button>
            </div>
          </div>
        )}

        {summary ? (
          <div className="relative z-[4] rounded-md border border-input bg-muted/40 p-3 text-xs">
            <p className="font-medium text-foreground">Import complete</p>
            <p className="mt-1 text-muted-foreground">
              {summary.imported} created · {summary.updated} updated · {summary.skipped} skipped
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="relative z-[4] text-xs text-destructive">{error}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
