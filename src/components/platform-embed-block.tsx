"use client"

/**
 * PlatformEmbedBlock — renders a URL as a native platform embed when
 * detected (Twitter/X, YouTube, Vimeo, Spotify, SoundCloud). Consumed by
 * `LinkPreviewCard`, which falls back to the generic OG card when no
 * platform match exists.
 */

import { useEffect, useRef } from "react"
import Script from "next/script"
import type { PlatformEmbedDescriptor } from "@/lib/platform-embeds"

declare global {
  interface Window {
    twttr?: {
      widgets?: {
        load: (el?: Element) => void
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
    const { aspect, fixedHeight, src } = embed
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
    return (
      <div className="relative w-full overflow-hidden rounded-lg border border-border">
        <iframe
          src={src}
          className="w-full"
          style={{ height: fixedHeight ?? 152 }}
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

  useEffect(() => {
    const tryLoad = () => {
      if (typeof window === "undefined") return
      if (!containerRef.current) return
      if (window.twttr?.widgets?.load) {
        window.twttr.widgets.load(containerRef.current)
      }
    }
    // Some mounts happen before the script has loaded the global. Retry a
    // few times, then give up — the <Script> below will trigger layout
    // when it finishes.
    tryLoad()
    const tick1 = setTimeout(tryLoad, 500)
    const tick2 = setTimeout(tryLoad, 1500)
    return () => {
      clearTimeout(tick1)
      clearTimeout(tick2)
    }
  }, [url])

  return (
    <div className="relative w-full">
      <div
        ref={containerRef}
        className="twitter-embed rounded-lg border border-border bg-muted/30 p-2"
      >
        <blockquote
          className="twitter-tweet"
          data-dnt="true"
          data-theme="dark"
          data-conversation="none"
        >
          <a href={url}>{originalUrl}</a>
        </blockquote>
      </div>
      <Script
        src="https://platform.twitter.com/widgets.js"
        strategy="lazyOnload"
        onReady={() => {
          if (typeof window !== "undefined" && containerRef.current) {
            window.twttr?.widgets?.load(containerRef.current)
          }
        }}
      />
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
