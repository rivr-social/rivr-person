import { auth } from "@/auth";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE =
  "private, no-store, max-age=0, must-revalidate";

/** Maximum response body size from a Pod (512 KB) */
const MAX_POD_RESPONSE_BYTES = 512 * 1024;

/** Fetch timeout for Pod requests (10 seconds) */
const POD_FETCH_TIMEOUT_MS = 10_000;

/** Common RDF namespace prefixes */
const NS_FOAF = "http://xmlns.com/foaf/0.1/";
const NS_VCARD = "http://www.w3.org/2006/vcard/ns#";
const NS_SCHEMA = "http://schema.org/";
const NS_SOLID = "http://www.w3.org/ns/solid/terms#";
const NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const NS_DC = "http://purl.org/dc/terms/";
const NS_LDP = "http://www.w3.org/ns/ldp#";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RDFTriple {
  subject: string;
  predicate: string;
  object: string;
  objectType: "uri" | "literal";
}

/** Structured data extracted from a Solid Pod profile */
export interface SolidProfileData {
  /** WebID URI that was resolved */
  webId: string;
  /** Display name */
  name: string | null;
  /** Profile photo / avatar URL */
  photo: string | null;
  /** Organization name */
  organization: string | null;
  /** Short bio or description */
  description: string | null;
  /** Homepage or personal URL */
  url: string | null;
  /** Email addresses found */
  emails: string[];
  /** Phone numbers found */
  phones: string[];
  /** "knows" links (friends/connections) */
  knows: string[];
  /** Public Type Index URI for discovering more resources */
  publicTypeIndex: string | null;
  /** Storage root URI */
  storage: string | null;
  /** All raw triples for advanced consumers */
  rawTriples: RDFTriple[];
}

interface ImportRequestBody {
  podUri: string;
}

interface ImportSuccessResponse {
  success: true;
  profile: SolidProfileData;
  /** Builder-ready resource representation */
  builderResources: BuilderResource[];
}

interface ImportErrorResponse {
  success: false;
  error: string;
}

interface BuilderResource {
  type: string;
  label: string;
  value: string;
  source: "solid-pod";
  sourceUri: string;
}

// ---------------------------------------------------------------------------
// Turtle parser (lightweight, handles common patterns)
// ---------------------------------------------------------------------------

/**
 * Lightweight Turtle / N3 parser that handles the subset of Turtle commonly
 * found in Solid Pod profile documents. This is intentionally not a full
 * spec-compliant parser — it covers:
 *   - @prefix declarations
 *   - Subject-predicate-object triples with URIs and string literals
 *   - Predicate-object lists (semicolons)
 *   - Blank nodes as [] shorthand
 *   - Multi-line string literals (triple-quoted)
 */
function parseTurtle(text: string, baseUri: string): RDFTriple[] {
  const triples: RDFTriple[] = [];
  const prefixes: Record<string, string> = {};

  // Normalize line endings
  let input = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove comments (lines starting with # outside strings)
  input = input.replace(/#[^\n]*/g, "");

  // Extract @prefix declarations
  const prefixRegex = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
  let prefixMatch: RegExpExecArray | null;
  while ((prefixMatch = prefixRegex.exec(input)) !== null) {
    prefixes[prefixMatch[1]] = prefixMatch[2];
  }

  // Extract @base
  const baseRegex = /@base\s+<([^>]+)>\s*\./;
  const baseMatch = baseRegex.exec(input);
  const resolvedBase = baseMatch ? baseMatch[1] : baseUri;

  // Remove prefix and base declarations for simpler statement parsing
  input = input.replace(/@prefix\s+\w*\s*:\s*<[^>]+>\s*\./g, "");
  input = input.replace(/@base\s+<[^>]+>\s*\./g, "");

  /** Resolve a prefixed name or URI to a full URI */
  function resolveUri(token: string): string {
    // Full URI
    if (token.startsWith("<") && token.endsWith(">")) {
      const uri = token.slice(1, -1);
      if (uri.startsWith("http://") || uri.startsWith("https://")) {
        return uri;
      }
      // Relative URI
      try {
        return new URL(uri, resolvedBase).toString();
      } catch {
        return uri;
      }
    }
    // Prefixed name
    if (token.includes(":")) {
      const colonIdx = token.indexOf(":");
      const prefix = token.slice(0, colonIdx);
      const local = token.slice(colonIdx + 1);
      if (prefix in prefixes) {
        return prefixes[prefix] + local;
      }
    }
    // "a" is shorthand for rdf:type
    if (token === "a") {
      return NS_RDF + "type";
    }
    return token;
  }

  /** Parse a token that may be a URI, prefixed name, or literal */
  function parseObject(
    token: string,
  ): { value: string; type: "uri" | "literal" } {
    const trimmed = token.trim();

    // String literal (possibly with language tag or datatype)
    if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
      const quote = trimmed.startsWith('"""') || trimmed.startsWith("'''")
        ? trimmed.slice(0, 3)
        : trimmed[0];
      const endIdx = trimmed.indexOf(
        quote,
        quote.length,
      );
      if (endIdx === -1) {
        return { value: trimmed.slice(quote.length), type: "literal" };
      }
      const literal = trimmed.slice(quote.length, endIdx);
      return { value: literal, type: "literal" };
    }

    // URI or prefixed name
    return { value: resolveUri(trimmed), type: "uri" };
  }

  // Tokenize and parse triples — split on "." for statement boundaries
  // This simplified approach processes statement blocks separated by "."
  const statements = input.split(/\.\s*(?=\s*(?:<|[a-zA-Z_]|\[))/);

  for (const stmt of statements) {
    const cleaned = stmt.trim();
    if (!cleaned) continue;

    // Split by semicolons for predicate-object lists
    const parts = cleaned.split(/\s*;\s*/);
    let currentSubject: string | null = null;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim().replace(/\.\s*$/, "");
      if (!part) continue;

      // Tokenize the part — extract URIs, prefixed names, and literals
      const tokens = tokenizeTurtlePart(part);
      if (tokens.length < 2 && i === 0) continue;

      if (i === 0) {
        // First part has subject + predicate + object
        if (tokens.length < 3) continue;
        currentSubject = resolveUri(tokens[0]);
        const predicate = resolveUri(tokens[1]);
        const objTokens = tokens.slice(2).join(" ");
        // Handle comma-separated object lists
        const objects = objTokens.split(/\s*,\s*/);
        for (const obj of objects) {
          if (!obj.trim()) continue;
          const parsed = parseObject(obj.trim());
          triples.push({
            subject: currentSubject,
            predicate,
            object: parsed.value,
            objectType: parsed.type,
          });
        }
      } else if (currentSubject && tokens.length >= 2) {
        // Continuation — predicate + object only
        const predicate = resolveUri(tokens[0]);
        const objTokens = tokens.slice(1).join(" ");
        const objects = objTokens.split(/\s*,\s*/);
        for (const obj of objects) {
          if (!obj.trim()) continue;
          const parsed = parseObject(obj.trim());
          triples.push({
            subject: currentSubject,
            predicate,
            object: parsed.value,
            objectType: parsed.type,
          });
        }
      }
    }
  }

  return triples;
}

/**
 * Tokenize a Turtle statement fragment, respecting quoted strings and
 * angle-bracket URIs as single tokens.
 */
function tokenizeTurtlePart(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    // Skip whitespace
    while (i < len && /\s/.test(input[i])) i++;
    if (i >= len) break;

    const ch = input[i];

    // Angle-bracket URI
    if (ch === "<") {
      const end = input.indexOf(">", i + 1);
      if (end === -1) {
        tokens.push(input.slice(i));
        break;
      }
      tokens.push(input.slice(i, end + 1));
      i = end + 1;
      continue;
    }

    // Triple-quoted string
    if (
      (ch === '"' && input.slice(i, i + 3) === '"""') ||
      (ch === "'" && input.slice(i, i + 3) === "'''")
    ) {
      const quote = input.slice(i, i + 3);
      const end = input.indexOf(quote, i + 3);
      if (end === -1) {
        tokens.push(input.slice(i));
        break;
      }
      // Include any trailing language tag or datatype
      let j = end + 3;
      while (j < len && /[^\s;,.]/.test(input[j])) j++;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }

    // Single-quoted string
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end === -1) {
        tokens.push(input.slice(i));
        break;
      }
      // Include any trailing language tag or datatype
      let j = end + 1;
      while (j < len && /[^\s;,.]/.test(input[j])) j++;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }

    // Regular token (prefixed name, keyword, etc.)
    let j = i;
    while (j < len && !/[\s;,]/.test(input[j])) j++;
    const token = input.slice(i, j).replace(/\.\s*$/, "");
    if (token) tokens.push(token);
    i = j;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// JSON-LD parser (lightweight, handles common Solid profile shapes)
// ---------------------------------------------------------------------------

function parseJsonLd(
  data: Record<string, unknown>,
  baseUri: string,
): RDFTriple[] {
  const triples: RDFTriple[] = [];
  const context = (data["@context"] ?? {}) as Record<string, string>;

  function resolveJsonLdUri(value: string): string {
    if (value.startsWith("http://") || value.startsWith("https://")) {
      return value;
    }
    if (value.includes(":")) {
      const [prefix, local] = value.split(":", 2);
      if (prefix in context) {
        return context[prefix] + local;
      }
    }
    return value;
  }

  const subjects = Array.isArray(data["@graph"])
    ? (data["@graph"] as Record<string, unknown>[])
    : [data];

  for (const subject of subjects) {
    const subjectId =
      typeof subject["@id"] === "string"
        ? resolveJsonLdUri(subject["@id"])
        : baseUri;

    for (const [key, value] of Object.entries(subject)) {
      if (key.startsWith("@")) continue;

      const predicate = resolveJsonLdUri(key);
      const values = Array.isArray(value) ? value : [value];

      for (const v of values) {
        if (v === null || v === undefined) continue;

        if (typeof v === "object" && v !== null) {
          const obj = v as Record<string, unknown>;
          if (typeof obj["@id"] === "string") {
            triples.push({
              subject: subjectId,
              predicate,
              object: resolveJsonLdUri(obj["@id"]),
              objectType: "uri",
            });
          } else if (typeof obj["@value"] === "string") {
            triples.push({
              subject: subjectId,
              predicate,
              object: obj["@value"],
              objectType: "literal",
            });
          }
        } else if (typeof v === "string") {
          // Heuristic: if it looks like a URI, treat it as one
          const isUri =
            v.startsWith("http://") ||
            v.startsWith("https://") ||
            v.includes(":");
          triples.push({
            subject: subjectId,
            predicate: predicate,
            object: isUri ? resolveJsonLdUri(v) : v,
            objectType: isUri ? "uri" : "literal",
          });
        }
      }
    }
  }

  return triples;
}

// ---------------------------------------------------------------------------
// Profile extraction from triples
// ---------------------------------------------------------------------------

function extractProfile(
  triples: RDFTriple[],
  webId: string,
): SolidProfileData {
  const profile: SolidProfileData = {
    webId,
    name: null,
    photo: null,
    organization: null,
    description: null,
    url: null,
    emails: [],
    phones: [],
    knows: [],
    publicTypeIndex: null,
    storage: null,
    rawTriples: triples,
  };

  // Helper: find first literal or URI value for a subject+predicate
  function findValue(
    subject: string,
    predicates: string[],
    preferLiteral = true,
  ): string | null {
    for (const pred of predicates) {
      const match = triples.find(
        (t) =>
          t.subject === subject &&
          t.predicate === pred &&
          (preferLiteral ? t.objectType === "literal" : true),
      );
      if (match) return match.object;

      // Fallback: try any object type
      if (preferLiteral) {
        const fallback = triples.find(
          (t) => t.subject === subject && t.predicate === pred,
        );
        if (fallback) return fallback.object;
      }
    }
    return null;
  }

  function findAllValues(subject: string, predicates: string[]): string[] {
    const results: string[] = [];
    for (const pred of predicates) {
      for (const t of triples) {
        if (t.subject === subject && t.predicate === pred) {
          results.push(t.object);
        }
      }
    }
    return results;
  }

  // Try to find the primary subject — could be the webId or the document URI
  const candidateSubjects = [
    webId,
    webId.replace(/#.*$/, ""),
    ...triples
      .filter((t) => t.predicate === NS_RDF + "type")
      .map((t) => t.subject),
  ];
  const uniqueSubjects = [...new Set(candidateSubjects)];

  for (const subject of uniqueSubjects) {
    // Name
    if (!profile.name) {
      profile.name = findValue(subject, [
        NS_FOAF + "name",
        NS_VCARD + "fn",
        NS_SCHEMA + "name",
        NS_RDFS + "label",
      ]);
    }

    // Photo
    if (!profile.photo) {
      profile.photo = findValue(subject, [
        NS_FOAF + "img",
        NS_FOAF + "depiction",
        NS_VCARD + "hasPhoto",
        NS_SCHEMA + "image",
      ], false);
    }

    // Organization
    if (!profile.organization) {
      profile.organization = findValue(subject, [
        NS_VCARD + "organization-name",
        NS_SCHEMA + "worksFor",
        NS_FOAF + "workplaceHomepage",
      ]);
    }

    // Description
    if (!profile.description) {
      profile.description = findValue(subject, [
        NS_SCHEMA + "description",
        NS_DC + "description",
        NS_VCARD + "note",
        NS_FOAF + "interest",
      ]);
    }

    // URL
    if (!profile.url) {
      profile.url = findValue(subject, [
        NS_SCHEMA + "url",
        NS_FOAF + "homepage",
        NS_FOAF + "weblog",
        NS_VCARD + "url",
      ], false);
    }

    // Emails
    const emails = findAllValues(subject, [
      NS_FOAF + "mbox",
      NS_VCARD + "hasEmail",
      NS_SCHEMA + "email",
    ]);
    for (const email of emails) {
      const cleaned = email.replace(/^mailto:/, "");
      if (cleaned && !profile.emails.includes(cleaned)) {
        profile.emails.push(cleaned);
      }
    }

    // Phones
    const phones = findAllValues(subject, [
      NS_FOAF + "phone",
      NS_VCARD + "hasTelephone",
      NS_SCHEMA + "telephone",
    ]);
    for (const phone of phones) {
      const cleaned = phone.replace(/^tel:/, "");
      if (cleaned && !profile.phones.includes(cleaned)) {
        profile.phones.push(cleaned);
      }
    }

    // Knows
    const knows = findAllValues(subject, [NS_FOAF + "knows"]);
    for (const k of knows) {
      if (!profile.knows.includes(k)) {
        profile.knows.push(k);
      }
    }

    // Public Type Index
    if (!profile.publicTypeIndex) {
      profile.publicTypeIndex = findValue(
        subject,
        [NS_SOLID + "publicTypeIndex"],
        false,
      );
    }

    // Storage
    if (!profile.storage) {
      profile.storage = findValue(
        subject,
        [NS_SOLID + "storage", `${NS_LDP}inbox`],
        false,
      );
    }
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Builder resource conversion
// ---------------------------------------------------------------------------

function profileToBuilderResources(
  profile: SolidProfileData,
): BuilderResource[] {
  const resources: BuilderResource[] = [];

  if (profile.name) {
    resources.push({
      type: "name",
      label: "Name",
      value: profile.name,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.photo) {
    resources.push({
      type: "photo",
      label: "Profile Photo",
      value: profile.photo,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.organization) {
    resources.push({
      type: "organization",
      label: "Organization",
      value: profile.organization,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.description) {
    resources.push({
      type: "description",
      label: "Description",
      value: profile.description,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.url) {
    resources.push({
      type: "url",
      label: "Website",
      value: profile.url,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  for (const email of profile.emails) {
    resources.push({
      type: "email",
      label: "Email",
      value: email,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  for (const phone of profile.phones) {
    resources.push({
      type: "phone",
      label: "Phone",
      value: phone,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  for (const webId of profile.knows) {
    resources.push({
      type: "connection",
      label: "Connection",
      value: webId,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.publicTypeIndex) {
    resources.push({
      type: "type-index",
      label: "Public Type Index",
      value: profile.publicTypeIndex,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  if (profile.storage) {
    resources.push({
      type: "storage",
      label: "Pod Storage",
      value: profile.storage,
      source: "solid-pod",
      sourceUri: profile.webId,
    });
  }

  return resources;
}

// ---------------------------------------------------------------------------
// URI validation
// ---------------------------------------------------------------------------

function isValidSolidPodUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/import-solid
// ---------------------------------------------------------------------------

export async function POST(
  request: NextRequest,
): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json(
      { success: false, error: "Authentication required" } satisfies ImportErrorResponse,
      {
        status: 401,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  let body: ImportRequestBody;
  try {
    body = (await request.json()) as ImportRequestBody;
  } catch {
    return Response.json(
      { success: false, error: "Invalid request body" } satisfies ImportErrorResponse,
      {
        status: 400,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  const { podUri } = body;

  if (!podUri || typeof podUri !== "string") {
    return Response.json(
      { success: false, error: "Missing required field: podUri" } satisfies ImportErrorResponse,
      {
        status: 400,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  if (!isValidSolidPodUri(podUri)) {
    return Response.json(
      {
        success: false,
        error:
          "Invalid Pod URI. Please provide a valid HTTP(S) URL (e.g., https://pod.example.com/profile/card#me)",
      } satisfies ImportErrorResponse,
      {
        status: 400,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  // Fetch the resource from the Solid Pod
  let responseText: string;
  let contentType: string;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      POD_FETCH_TIMEOUT_MS,
    );

    // Strip fragment for HTTP request (fragments are client-side)
    const fetchUri = podUri.split("#")[0];

    const podResponse = await fetch(fetchUri, {
      method: "GET",
      headers: {
        Accept:
          "text/turtle, application/ld+json, application/n-triples, text/n3, application/rdf+xml;q=0.5",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!podResponse.ok) {
      const statusText = podResponse.statusText || "Unknown error";
      return Response.json(
        {
          success: false,
          error: `Pod returned ${podResponse.status} ${statusText}. The resource may not exist or may require authentication.`,
        } satisfies ImportErrorResponse,
        {
          status: 502,
          headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
        },
      );
    }

    contentType = podResponse.headers.get("content-type") ?? "";

    // Read with size limit
    const reader = podResponse.body?.getReader();
    if (!reader) {
      return Response.json(
        { success: false, error: "Empty response from Pod" } satisfies ImportErrorResponse,
        {
          status: 502,
          headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
        },
      );
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_POD_RESPONSE_BYTES) {
        reader.cancel();
        return Response.json(
          {
            success: false,
            error: "Pod response too large (exceeds 512 KB limit)",
          } satisfies ImportErrorResponse,
          {
            status: 413,
            headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
          },
        );
      }

      chunks.push(value);
    }

    const decoder = new TextDecoder();
    responseText = chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
      decoder.decode();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return Response.json(
        {
          success: false,
          error: "Request to Pod timed out after 10 seconds",
        } satisfies ImportErrorResponse,
        {
          status: 504,
          headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
        },
      );
    }

    const message =
      err instanceof Error ? err.message : "Unknown error";
    return Response.json(
      {
        success: false,
        error: `Failed to reach Pod: ${message}. This may be a network or CORS issue.`,
      } satisfies ImportErrorResponse,
      {
        status: 502,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  // Parse the RDF data
  let triples: RDFTriple[];

  try {
    if (
      contentType.includes("application/ld+json") ||
      contentType.includes("application/json")
    ) {
      const jsonData = JSON.parse(responseText) as Record<string, unknown>;
      triples = parseJsonLd(jsonData, podUri);
    } else {
      // Default to Turtle parsing (handles text/turtle, text/n3, etc.)
      triples = parseTurtle(responseText, podUri);
    }
  } catch (parseErr) {
    const message =
      parseErr instanceof Error ? parseErr.message : "Unknown parse error";
    return Response.json(
      {
        success: false,
        error: `Failed to parse RDF data: ${message}. The resource may not be valid Turtle or JSON-LD.`,
      } satisfies ImportErrorResponse,
      {
        status: 422,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  if (triples.length === 0) {
    return Response.json(
      {
        success: false,
        error:
          "No RDF triples found in the response. The resource may be empty or in an unsupported format.",
      } satisfies ImportErrorResponse,
      {
        status: 422,
        headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
      },
    );
  }

  // Extract structured profile data
  const profile = extractProfile(triples, podUri);

  // Convert to builder resources
  const builderResources = profileToBuilderResources(profile);

  const result: ImportSuccessResponse = {
    success: true,
    profile,
    builderResources,
  };

  return Response.json(result, {
    status: 200,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}
