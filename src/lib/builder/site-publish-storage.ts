/**
 * @fileoverview MinIO/S3 storage for *published* builder sites (publish -> serve
 * on custom domains).
 *
 * The general-purpose uploader in `src/lib/storage.ts` enforces an image/doc
 * MIME allowlist that intentionally excludes `text/html`, `text/css`, and
 * `application/javascript`, so it cannot store site files. This module owns the
 * publish/serve object path instead:
 *
 *   - {@link putPublishedSite}   writes a `SiteFiles` map under
 *     `site-publications/<publicationId>/…`, one object per file, each with a
 *     content-type derived from its extension.
 *   - {@link getPublishedObject}  streams one published object back for the
 *     host-dispatch route (returns null on a missing key -> 404).
 *
 * The pure helpers ({@link contentTypeForPath}, {@link sanitizeSitePath},
 * {@link normalizeRequestPath}) carry no I/O so they are unit-testable and are
 * reused by the host-dispatch route to resolve a request path to an object key.
 */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getEnv } from '@/lib/env';
import type { SiteFiles } from '@/lib/bespoke/site-files';

/** Object-key prefix under which every publication's files are stored. */
export const SITE_PUBLICATIONS_ROOT = 'site-publications';

/** The document served when a request targets a directory (no explicit file). */
export const DEFAULT_DOCUMENT = 'index.html';

/** Fallback content-type for objects with an unrecognized extension. */
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * Extension -> content-type map for published static-site assets. Deliberately
 * small: the builder emits HTML/CSS/JS plus a handful of text/vector types.
 */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  webmanifest: 'application/manifest+json',
  ico: 'image/x-icon',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

/** Returns the content-type for a file path from its extension. */
export function contentTypeForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return DEFAULT_CONTENT_TYPE;
  const ext = path.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? DEFAULT_CONTENT_TYPE;
}

/**
 * Sanitizes a site-relative file path into a safe object-key suffix: strips a
 * leading slash, collapses `.`/`..` traversal segments, and drops empty
 * segments. Returns "" when nothing safe remains (caller treats as invalid).
 */
export function sanitizeSitePath(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/');
}

/**
 * Normalizes an incoming HTTP request path to the object path to serve. A root
 * or directory-style request ("" or ending in "/") resolves to the directory's
 * {@link DEFAULT_DOCUMENT}. Traversal segments are stripped.
 */
export function normalizeRequestPath(requestPath: string): string {
  const trimmed = (requestPath ?? '').replace(/^\/+/, '');
  if (trimmed === '' || trimmed.endsWith('/')) {
    return sanitizeSitePath(`${trimmed}${DEFAULT_DOCUMENT}`);
  }
  return sanitizeSitePath(trimmed);
}

/** Builds the full object key for a publication's file. */
export function publicationObjectKey(prefix: string, path: string): string {
  const cleanPrefix = prefix.replace(/\/+$/, '');
  return `${cleanPrefix}/${sanitizeSitePath(path)}`;
}

/** Builds the storage prefix for a publication id. */
export function publicationPrefix(publicationId: string): string {
  return `${SITE_PUBLICATIONS_ROOT}/${publicationId}`;
}

// ---------------------------------------------------------------------------
// S3 client (isolated from src/lib/storage.ts's private client)
// ---------------------------------------------------------------------------

let siteS3Client: S3Client | null = null;

/** Gets/creates the S3 client configured for MinIO (mirrors src/lib/storage.ts). */
function getSiteS3Client(): S3Client {
  if (siteS3Client) return siteS3Client;
  const endpoint = getEnv('MINIO_ENDPOINT');
  const port = getEnv('MINIO_PORT');
  const accessKeyId = getEnv('MINIO_ACCESS_KEY');
  const secretAccessKey = getEnv('MINIO_SECRET_KEY');
  const useSSL = getEnv('MINIO_USE_SSL') === 'true';
  const protocol = useSSL ? 'https' : 'http';
  siteS3Client = new S3Client({
    endpoint: `${protocol}://${endpoint}:${port}`,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return siteS3Client;
}

/** The bucket published site files are written to/read from. */
export function siteBucket(): string {
  return getEnv('MINIO_BUCKET_UPLOADS');
}

/** Error type for site-storage failures with root-cause context. */
export class SitePublishStorageError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'SitePublishStorageError';
  }
}

/** Result of a publish-to-storage write. */
export interface PutPublishedSiteResult {
  bucket: string;
  prefix: string;
  /** Sanitized relative paths actually written. */
  paths: string[];
}

/**
 * Writes every file in `files` under `site-publications/<publicationId>/…`,
 * one object per file with an extension-derived content-type. Files whose path
 * sanitizes to empty are skipped.
 *
 * @throws {SitePublishStorageError} When the underlying object write fails.
 */
export async function putPublishedSite(
  publicationId: string,
  files: SiteFiles,
): Promise<PutPublishedSiteResult> {
  const bucket = siteBucket();
  const prefix = publicationPrefix(publicationId);
  const client = getSiteS3Client();
  const paths: string[] = [];

  try {
    await Promise.all(
      Object.entries(files).map(async ([rawPath, content]) => {
        const relative = sanitizeSitePath(rawPath);
        if (!relative) return;
        const params: PutObjectCommandInput = {
          Bucket: bucket,
          Key: publicationObjectKey(prefix, relative),
          Body: Buffer.from(content ?? '', 'utf-8'),
          ContentType: contentTypeForPath(relative),
        };
        await client.send(new PutObjectCommand(params));
        paths.push(relative);
      }),
    );
  } catch (error) {
    throw new SitePublishStorageError('Failed to write published site files to storage', error);
  }

  return { bucket, prefix, paths };
}

/** A single published object fetched for serving. */
export interface PublishedObject {
  body: Buffer;
  contentType: string;
}

/**
 * Fetches one published object by bucket/prefix/request-path. Returns null when
 * the object does not exist (host-dispatch renders a 404 page).
 *
 * @throws {SitePublishStorageError} On non-NotFound storage errors.
 */
export async function getPublishedObject(
  bucket: string,
  prefix: string,
  requestPath: string,
): Promise<PublishedObject | null> {
  const relative = normalizeRequestPath(requestPath);
  if (!relative) return null;
  const key = publicationObjectKey(prefix, relative);
  const client = getSiteS3Client();
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return {
      body: Buffer.from(bytes),
      contentType: response.ContentType || contentTypeForPath(relative),
    };
  } catch (error) {
    const code =
      (error as { name?: string; Code?: string })?.name ??
      (error as { Code?: string })?.Code ??
      '';
    if (code === 'NoSuchKey' || code === 'NotFound' || code === 'NoSuchBucket') {
      return null;
    }
    throw new SitePublishStorageError(`Failed to read published object ${key}`, error);
  }
}

/** Resets the cached S3 client (test hook). */
export function resetSiteS3Client(): void {
  siteS3Client = null;
}
