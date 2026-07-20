/**
 * Text preparation for speech synthesis surfaces.
 *
 * Assistant replies are markdown; TTS engines read the syntax aloud
 * unless it is stripped first.
 */

const MAX_SPEECH_CHARS = 2000;

export function stripMarkdownForSpeech(markdown: string): string {
  return (
    markdown
      // fenced code blocks -> spoken placeholder
      .replace(/```[\s\S]*?```/g, " code block omitted. ")
      // inline code
      .replace(/`([^`]+)`/g, "$1")
      // images -> alt text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      // links -> label
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      // headings, blockquotes, list markers
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // bold / italics / strikethrough
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      // tables and horizontal rules
      .replace(/^\|.*\|$/gm, "")
      .replace(/^[-=_]{3,}$/gm, "")
      // collapse whitespace
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SPEECH_CHARS)
  );
}
