"use client"

/**
 * PlatformEmbedBlock — renders a URL as a native platform embed when
 * detected (Twitter/X, YouTube, Vimeo, Spotify, SoundCloud). Consumed by
 * `LinkPreviewCard`, which falls back to the generic OG card when no
 * platform match exists.
 */

import { useEffect, useRef, useState, type CSSProperties } from "react"
import type { PlatformEmbedDescriptor } from "@/lib/platform-embeds"

declare global {
  interface Window {
    twttr?: {
      widgets?: {
        load: (el?: Element) => void
        createTweet: (
          tweetId: string,
          container: HTMLElement,
          options?: Record<string, unknown>,
        ) => Promise<HTMLElement>
      }
    }
  }
}

interface PlatformEmbedBlockProps {
  url: string
  embed: PlatformEmbedDescriptor
  onRemove?: () => void
}

export function PlatformEmbedBlock({ url, embed, onRemove }: PlatformEmbedBlockProps) {
  const removeButton = onRemove ? (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onRemove()
      }}
      className="absolute right-1 top-1 rounded-full bg-background/90 p-1 text-muted-foreground shadow hover:text-foreground"
      aria-label="Remove embed"
    >
      <span aria-hidden="true">×</span>
    </button>
  ) : null

  if (embed.embedKind === "iframe") {
    const { aspect, fixedHeight, fixedWidth, src } = embed
    // Aspect-ratio iframes (video) use a responsive container; fixed-height
    // iframes (music) just set height directly.
    if (aspect) {
      return (
        <div
          className="relative w-full overflow-hidden rounded-lg border border-border bg-black"
          style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }}
        >
          <iframe
            src={src}
            className="absolute inset-0 h-full w-full"
            loading="lazy"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            title={labelForPlatform(embed.platform, url)}
            referrerPolicy="strict-origin-when-cross-origin"
          />
          {removeButton}
        </div>
      )
    }
    // Fixed-width plugin iframes (e.g. Facebook's 500px Social Plugin) need
    // to be centered and constrained; letting them go w-full exposes the
    // plugin's own white background as whitespace on one side.
    const iframeStyle: CSSProperties = fixedWidth
      ? { height: fixedHeight ?? 152, width: fixedWidth, maxWidth: "100%" }
      : { height: fixedHeight ?? 152 }
    return (
      <div
        className={`relative overflow-hidden rounded-lg border border-border ${
          fixedWidth ? "mx-auto flex justify-center" : "w-full"
        }`}
        style={fixedWidth ? { maxWidth: fixedWidth } : undefined}
      >
        <iframe
          src={src}
          className={fixedWidth ? undefined : "w-full"}
          style={iframeStyle}
          loading="lazy"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
          title={labelForPlatform(embed.platform, url)}
          referrerPolicy="strict-origin-when-cross-origin"
        />
        {removeButton}
      </div>
    )
  }

  // Twitter / X: blockquote + widgets.js. `widgets.load` is idempotent so
  // re-renders in feed scroll won't double-insert.
  return <TwitterBlockquote url={embed.tweetUrl} originalUrl={url} onRemove={onRemove} />
}

/**
 * Twitter tweet embed.
 *
 * Uses `twttr.widgets.createTweet(tweetId, container, options)` rather than
 * the blockquote + widgets.load pattern because it's more reliable:
 * - no dependence on Next's Script `onReady` timing
 * - explicit container means no DOM-sweep race on feed renders
 * - cleaner error path — we can observe the promise rejection if the
 *   syndication call fails and degrade to the linked-URL fallback.
 *
 * widgets.js is loaded once per document via a module-level promise and
 * reused for every embed on the page.
 */
let widgetsPromise: Promise<void> | null = null
function loadTwitterWidgets(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.twttr?.widgets?.createTweet) return Promise.resolve()
  if (widgetsPromise) return widgetsPromise
  widgetsPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://platform.twitter.com/widgets.js"]',
    )
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", (e) => reject(e), { once: true })
      return
    }
    const script = document.createElement("script")
    script.src = "https://platform.twitter.com/widgets.js"
    script.async = true
    script.charset = "utf-8"
    script.onload = () => resolve()
    script.onerror = (e) => reject(e)
    document.body.appendChild(script)
  })
  return widgetsPromise
}

function tweetIdFromUrl(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/\/status\/(\d+)/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

function TwitterBlockquote({
  url,
  originalUrl,
  onRemove,
}: {
  url: string
  originalUrl: string
  onRemove?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState(false)
  const tweetId = tweetIdFromUrl(url)

  useEffect(() => {
    if (!tweetId || !containerRef.current) return
    let cancelled = false
    void loadTwitterWidgets()
      .then(() => {
        if (cancelled || !containerRef.current) return
        const twttr = window.twttr
        if (!twttr?.widgets?.createTweet) return
        // Clear any prior render so feed re-renders don't stack embeds.
        containerRef.current.innerHTML = ""
        return twttr.widgets.createTweet(tweetId, containerRef.current, {
          theme: "dark",
          dnt: true,
          conversation: "none",
          align: "center",
        })
      })
      .then(() => {
        if (!cancelled) setRendered(true)
      })
      .catch((err: unknown) => {
        console.warn("[TwitterEmbed] failed to render tweet", err)
      })
    return () => {
      cancelled = true
    }
  }, [tweetId])

  return (
    <div className="relative w-full">
      {/*
        Twitter injects a shadow-DOM iframe into this container. React must
        NOT own any children here — if React re-renders while widgets.js has
        mutated the subtree, the reconciler throws a NotFoundError on
        removeChild. The fallback link below is a sibling, not a child.
      */}
      <div
        ref={containerRef}
        className="twitter-embed min-h-[80px] w-full"
        data-tweet-url={url}
        suppressHydrationWarning
      />
      {!rendered ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="pointer-events-auto absolute inset-0 flex items-center justify-center rounded-lg border border-border bg-muted/30 px-3 py-4 text-sm text-muted-foreground hover:text-foreground"
        >
          Loading tweet — {originalUrl}
        </a>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onRemove()
          }}
          className="absolute right-1 top-1 rounded-full bg-background/90 p-1 text-muted-foreground shadow hover:text-foreground"
          aria-label="Remove embed"
        >
          <span aria-hidden="true">×</span>
        </button>
      ) : null}
    </div>
  )
}

function labelForPlatform(platform: PlatformEmbedDescriptor["platform"], url: string): string {
  switch (platform) {
    case "youtube":
      return "YouTube video"
    case "vimeo":
      return "Vimeo video"
    case "spotify":
      return "Spotify player"
    case "soundcloud":
      return "SoundCloud player"
    case "facebook":
      return "Facebook post"
    default:
      return url
  }
}
