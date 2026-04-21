/**
 * Platform embed detection — maps a URL to a rich native-embed descriptor
 * when the URL belongs to a platform we know how to render inline
 * (Twitter/X, YouTube, Vimeo, Spotify, SoundCloud).
 *
 * Non-matching URLs fall back to the generic OpenGraph card rendered by
 * `LinkPreviewCard`. Keep this module free of React + Node imports so it
 * can be shared between server actions (post-time URL classification)
 * and the client preview renderer.
 */

/** Native embed descriptor. */
export type PlatformEmbedDescriptor =
  | {
      platform: "twitter";
      embedKind: "twitter-blockquote";
      /** Canonical tweet URL (passed to platform.twitter.com/widgets.js). */
      tweetUrl: string;
    }
  | {
      platform: "youtube" | "vimeo" | "spotify" | "soundcloud";
      embedKind: "iframe";
      /** Iframe src. Always HTTPS, platform-owned origin. */
      src: string;
      /** Optional aspect ratio (width:height). `undefined` = fixed height. */
      aspect?: { width: number; height: number };
      /** Optional fixed pixel height when no aspect ratio applies. */
      fixedHeight?: number;
    };

const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{6,}$/;
const SPOTIFY_ID_REGEX = /^[A-Za-z0-9]+$/;

/**
 * Classify a URL and return a platform-specific embed descriptor, or
 * `null` when no specialized embed is known.
 *
 * @param url Raw URL string, already extracted from post content.
 */
export function detectPlatformEmbed(url: string): PlatformEmbedDescriptor | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");

  // --- Twitter / X ---
  if (host === "twitter.com" || host === "x.com" || host === "mobile.twitter.com") {
    if (/^\/[^/]+\/status\/\d+/.test(parsed.pathname)) {
      // Always pass the canonical x.com URL to widgets.js — it transparently
      // handles both twitter.com and x.com, and x.com is the canonical host
      // since Twitter's rebrand.
      const canonical = new URL(parsed.toString());
      canonical.hostname = "x.com";
      return {
        platform: "twitter",
        embedKind: "twitter-blockquote",
        tweetUrl: canonical.toString(),
      };
    }
  }

  // --- YouTube ---
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    let videoId: string | null = null;
    if (host === "youtu.be") {
      videoId = parsed.pathname.slice(1).split("/")[0] || null;
    } else if (parsed.pathname === "/watch") {
      videoId = parsed.searchParams.get("v");
    } else {
      const match = parsed.pathname.match(/^\/(?:embed|shorts)\/([^/?#]+)/);
      videoId = match ? match[1] : null;
    }
    if (videoId && YOUTUBE_VIDEO_ID_REGEX.test(videoId)) {
      const startSec = parseStartSeconds(parsed);
      const query = startSec ? `?start=${startSec}` : "";
      return {
        platform: "youtube",
        embedKind: "iframe",
        // youtube-nocookie is the privacy-friendly embed domain — no tracking
        // cookies until the user hits play.
        src: `https://www.youtube-nocookie.com/embed/${videoId}${query}`,
        aspect: { width: 16, height: 9 },
      };
    }
  }

  // --- Vimeo ---
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const idMatch = parsed.pathname.match(/(?:^|\/)(?:video\/)?(\d{3,})(?:\/|$)/);
    if (idMatch) {
      return {
        platform: "vimeo",
        embedKind: "iframe",
        src: `https://player.vimeo.com/video/${idMatch[1]}`,
        aspect: { width: 16, height: 9 },
      };
    }
  }

  // --- Spotify ---
  if (host === "open.spotify.com") {
    const match = parsed.pathname.match(
      /^\/(track|album|playlist|episode|show|artist)\/([^/?#]+)/,
    );
    if (match && SPOTIFY_ID_REGEX.test(match[2])) {
      return {
        platform: "spotify",
        embedKind: "iframe",
        src: `https://open.spotify.com/embed/${match[1]}/${match[2]}`,
        fixedHeight: match[1] === "track" || match[1] === "episode" ? 152 : 352,
      };
    }
  }

  // --- SoundCloud ---
  if (host === "soundcloud.com") {
    if (parsed.pathname.split("/").filter(Boolean).length >= 2) {
      const encoded = encodeURIComponent(parsed.toString());
      return {
        platform: "soundcloud",
        embedKind: "iframe",
        src: `https://w.soundcloud.com/player/?url=${encoded}&color=%23ff5500&auto_play=false&hide_related=true&show_user=true&visual=true`,
        fixedHeight: 166,
      };
    }
  }

  return null;
}

/**
 * Parse a `t=<seconds>` / `start=<seconds>` query param from a YouTube URL.
 * Accepts the common `1m30s` form and coerces it to raw seconds.
 */
function parseStartSeconds(parsed: URL): number | null {
  const raw = parsed.searchParams.get("t") ?? parsed.searchParams.get("start");
  if (!raw) return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber);
  }
  const match = raw.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return null;
  const [, h, m, s] = match;
  const total = (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0);
  return total > 0 ? total : null;
}
