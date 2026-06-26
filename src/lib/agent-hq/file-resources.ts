/**
 * @fileoverview Pure helpers for turning an uploaded file into a Resource and
 * for sharing a stored file Resource as a post (Wave 2 / T2.3).
 *
 * No database access and no Node-only APIs — the route layer handles auth,
 * storage, and persistence, then calls these to (a) classify a MIME type into a
 * `ResourceType` and (b) shape the share-as-post embed from a file Resource.
 * Keeping the classification/embed logic here makes it unit-testable and keeps
 * the routes thin.
 */
import type { ResourceEmbed, ResourceType } from "@/db/schema";

/** Resource types this module may assign to an uploaded file. */
export type FileResourceType = Extract<
  ResourceType,
  "image" | "video" | "audio" | "document" | "file"
>;

/**
 * Classifies an upload's MIME type into the narrowest matching `ResourceType`.
 * `image/*`, `video/*`, `audio/*` map to their media type; PDFs and text map to
 * `document`; everything else (and an empty/unknown type) falls back to the
 * generic `file` bucket. Matching is case-insensitive.
 */
export function resourceTypeForMime(mimeType: string | null | undefined): FileResourceType {
  const mime = (mimeType ?? "").trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  return "file";
}

/** The minimal file Resource shape needed to build a share-as-post embed. */
export interface ShareableFileResource {
  name: string | null;
  type: ResourceType;
  /** Public URL of the stored object (resource `url` column or `metadata.url`). */
  url: string | null;
  contentType: string | null;
}

/**
 * Builds the post embed for sharing a file Resource. Images surface as an
 * `image` embed (so the post card renders the picture inline); every other file
 * type surfaces as a `link` embed labelled with the resource name so the card
 * renders a titled link to the stored object. Returns `null` when the resource
 * has no resolvable URL (nothing to embed).
 */
export function shapeShareEmbed(resource: ShareableFileResource): ResourceEmbed | null {
  const url = resource.url?.trim();
  if (!url) return null;
  const isImage =
    resource.type === "image" ||
    (resource.contentType ?? "").trim().toLowerCase().startsWith("image/");
  if (isImage) {
    return { url, kind: "image" };
  }
  const title = resource.name?.trim();
  return {
    url,
    kind: "link",
    ...(title ? { ogTitle: title } : {}),
  };
}
