// ---------------------------------------------------------------------------
// Site file management utilities for the AI-powered builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of filename to file content */
export type SiteFiles = Record<string, string>;

/** Parsed LLM response containing conversation text and extracted code files */
export interface ParsedLLMResponse {
  message: string;
  files: SiteFiles;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to match fenced code blocks with file paths.
 *
 * Supports formats:
 *   ```html:index.html
 *   ```css:style.css
 *   ```js:script.js
 *   ```javascript:app.js
 *
 * The language tag is optional — ```index.html also works.
 */
const CODE_BLOCK_REGEX =
  /```(?:(?:html|css|js|javascript|json|txt|svg|xml)\s*:\s*)?([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\s*\n([\s\S]*?)```/g;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response string, extracting any code blocks that specify
 * file paths. Everything outside code blocks is treated as conversational
 * text.
 */
export function parseLLMResponse(text: string): ParsedLLMResponse {
  const files: SiteFiles = {};
  let message = text;

  // Extract all code blocks that have file paths
  const matches = [...text.matchAll(CODE_BLOCK_REGEX)];

  for (const match of matches) {
    const filePath = match[1].trim();
    const content = match[2];

    if (filePath && content !== undefined) {
      files[filePath] = content.trimEnd();
      // Remove the code block from the message text
      message = message.replace(match[0], "").trim();
    }
  }

  // Clean up excessive whitespace from removed blocks
  message = message.replace(/\n{3,}/g, "\n\n").trim();

  return { message, files };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Merge updated files into the existing file set. Updated files overwrite
 * existing files with the same name. Files not in the update set are
 * preserved.
 */
export function mergeSiteFiles(
  existing: SiteFiles,
  updates: SiteFiles,
): SiteFiles {
  return { ...existing, ...updates };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Get a sorted list of filenames from a SiteFiles map */
export function listFileNames(files: SiteFiles): string[] {
  return Object.keys(files).sort((a, b) => {
    // index.html always first
    if (a === "index.html") return -1;
    if (b === "index.html") return 1;
    // Then CSS
    if (a.endsWith(".css") && !b.endsWith(".css")) return -1;
    if (!a.endsWith(".css") && b.endsWith(".css")) return 1;
    // Then JS
    if (a.endsWith(".js") && !b.endsWith(".js")) return -1;
    if (!a.endsWith(".js") && b.endsWith(".js")) return 1;
    return a.localeCompare(b);
  });
}

/** Determine the language for syntax highlighting from a filename */
export function getFileLanguage(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "js":
      return "javascript";
    case "json":
      return "json";
    case "svg":
      return "svg";
    case "xml":
      return "xml";
    default:
      return "text";
  }
}
