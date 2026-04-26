"use client"

/**
 * Unified post Share menu.
 *
 * Provides a single <ShareMenu post={post}> trigger that:
 *  - On mobile (or anywhere `navigator.share` is available + supported for the
 *    payload), invokes the Web Share API so the OS share sheet picks the app.
 *  - Otherwise opens a dropdown with copy-link + per-platform share links.
 *
 * Platform links are plain `https://` URLs opened in popup windows via
 * `window.open(..., "_blank", "noopener,noreferrer,popup")`. No iframes,
 * no cross-origin fetches — so no CSP connect-src or frame-src changes
 * are required.
 */

import * as React from "react"
import { Share2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/components/ui/use-toast"
import { cn } from "@/lib/utils"

/** Character budgets for the Web Share API payload and text fallbacks. */
const TITLE_FALLBACK_LENGTH = 60
const TEXT_EXCERPT_LENGTH = 200
const POPUP_WIDTH = 600
const POPUP_HEIGHT = 500
const SCROLL_CLICK_THRESHOLD_PX = 8

/** Minimal post shape the share menu needs. Keeps the component decoupled
 *  from the full `Post` type so it can be reused from feed + detail views. */
export type SharePostInput = {
  id: string
  title?: string | null
  content?: string | null
}

type ShareMenuProps = {
  post: SharePostInput
  /** Optional extra classes forwarded to the trigger Button. */
  className?: string
  /** Optional stopPropagation wrapper — useful when the trigger sits inside
   *  a clickable Card. Callers can pass their existing handler. */
  onTriggerClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}

type SharePayload = {
  url: string
  title: string
  text: string
}

/**
 * Build the canonical share payload from a post. The URL uses the current
 * window origin so it works across `app.rivr.social`, sovereign runtimes
 * like `rivr.camalot.me`, and any other deploy target.
 */
function buildSharePayload(post: SharePostInput): SharePayload {
  const origin = typeof window !== "undefined" ? window.location.origin : ""
  const url = `${origin}/posts/${post.id}`

  const content = (post.content ?? "").trim()
  const rawTitle = (post.title ?? "").trim()
  const title = rawTitle || content.slice(0, TITLE_FALLBACK_LENGTH) || "Post on RIVR"
  const text = content.slice(0, TEXT_EXCERPT_LENGTH)

  return { url, title, text }
}

/** Open an external share URL in a sized popup. `rel` on anchors is not
 *  honored by `window.open`, so we explicitly pass "noopener,noreferrer". */
function openShareWindow(url: string) {
  if (typeof window === "undefined") return
  const left = Math.max(0, Math.round((window.innerWidth - POPUP_WIDTH) / 2))
  const top = Math.max(0, Math.round((window.innerHeight - POPUP_HEIGHT) / 2))
  const features = `popup=yes,noopener,noreferrer,width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top}`
  const win = window.open(url, "_blank", features)
  if (win) {
    // Defense in depth — some browsers still leak `opener` even with the
    // feature string above.
    try {
      win.opener = null
    } catch {
      /* ignore cross-origin assignment errors */
    }
  }
}

/**
 * True when the platform exposes a Web Share API that is also willing to
 * share the given payload. We consult `canShare` when available so we only
 * hand off to the OS sheet when it will actually accept our data.
 */
function canUseWebShare(payload: SharePayload): boolean {
  if (typeof navigator === "undefined") return false
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean
  }
  if (typeof nav.share !== "function") return false
  if (typeof nav.canShare === "function") {
    try {
      return nav.canShare(payload)
    } catch {
      return false
    }
  }
  return true
}

/** Encode helper. `encodeURIComponent` on its own is the right call here —
 *  none of the share endpoints want `+` for spaces. */
const enc = (value: string) => encodeURIComponent(value)

type PlatformLinkBuilder = (payload: SharePayload) => string

type PlatformDescriptor = {
  key: string
  label: string
  buildUrl: PlatformLinkBuilder
  icon: React.ReactNode
}

/* ---------- Inline brand SVGs (single-color, currentColor) ---------- *
 * We intentionally avoid pulling in react-icons / simple-icons for a
 * lone share menu — six extra icons is cheaper than a new dep. Each
 * path is the Simple Icons 24x24 glyph, redrawn here under their CC0
 * license so we can size them from the parent. */

const iconClass = "h-4 w-4 shrink-0"

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.412c0-3.017 1.792-4.686 4.533-4.686 1.312 0 2.686.235 2.686.235v2.965h-1.513c-1.49 0-1.956.93-1.956 1.886v2.267h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z" />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.852 3.37-1.852 3.601 0 4.267 2.37 4.267 5.455v6.288zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.063 2.063 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  )
}

function RedditIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.07 2.961-.913a.361.361 0 00.029-.463.33.33 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.095z" />
    </svg>
  )
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.570-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  )
}

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="currentColor">
      <path d="M11.944 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0a12 12 0 00-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 01.171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.329-.913.489-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  )
}

function EmailIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.07 0l3-3a5 5 0 10-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 00-7.07 0l-3 3a5 5 0 107.07 7.07l1.5-1.5" />
    </svg>
  )
}

/** Outbound share targets. Order here drives menu order. */
const PLATFORMS: PlatformDescriptor[] = [
  {
    key: "facebook",
    label: "Facebook",
    buildUrl: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
    icon: <FacebookIcon />,
  },
  {
    key: "x",
    label: "X (Twitter)",
    buildUrl: ({ url, text }) => `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(text)}`,
    icon: <XIcon />,
  },
  {
    key: "linkedin",
    label: "LinkedIn",
    buildUrl: ({ url }) => `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
    icon: <LinkedInIcon />,
  },
  {
    key: "reddit",
    label: "Reddit",
    buildUrl: ({ url, title }) => `https://reddit.com/submit?url=${enc(url)}&title=${enc(title)}`,
    icon: <RedditIcon />,
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    buildUrl: ({ url, text }) => `https://wa.me/?text=${enc(`${text} ${url}`.trim())}`,
    icon: <WhatsAppIcon />,
  },
  {
    key: "telegram",
    label: "Telegram",
    buildUrl: ({ url, text }) => `https://t.me/share/url?url=${enc(url)}&text=${enc(text)}`,
    icon: <TelegramIcon />,
  },
  {
    key: "email",
    label: "Email",
    buildUrl: ({ url, title, text }) =>
      `mailto:?subject=${enc(title)}&body=${enc(`${text}\n\n${url}`.trim())}`,
    icon: <EmailIcon />,
  },
]

/**
 * Share menu trigger + dropdown.
 *
 * The trigger always renders as a ghost footer button matching the other
 * post action buttons (Like, Comment, Thank). When clicked we first try
 * `navigator.share` — if that resolves we never open the dropdown. If the
 * Web Share API is unavailable (or `AbortError` comes back because it was
 * invoked without a user gesture), the Radix dropdown takes over.
 */
export function ShareMenu({ post, className, onTriggerClick }: ShareMenuProps) {
  const { toast } = useToast()
  const [open, setOpen] = React.useState(false)
  const pointerStartRef = React.useRef<{ x: number; y: number; scrollY: number } | null>(null)
  const suppressNextClickRef = React.useRef(false)

  const handleCopy = React.useCallback(
    async (payload: SharePayload) => {
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(payload.url)
        } else if (typeof window !== "undefined") {
          // Legacy fallback — execCommand still works when clipboard API is blocked.
          const textarea = document.createElement("textarea")
          textarea.value = payload.url
          textarea.setAttribute("readonly", "")
          textarea.style.position = "absolute"
          textarea.style.left = "-9999px"
          document.body.appendChild(textarea)
          textarea.select()
          document.execCommand("copy")
          document.body.removeChild(textarea)
        }
        toast({ title: "Link copied", description: payload.url })
      } catch (error) {
        toast({
          title: "Could not copy link",
          description: error instanceof Error ? error.message : "Clipboard unavailable.",
          variant: "destructive",
        })
      }
    },
    [toast],
  )

  const handleTriggerClick = React.useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      if (onTriggerClick) onTriggerClick(event)
      // Prevent the dropdown from opening reflexively — we decide below.
      const payload = buildSharePayload(post)

      if (canUseWebShare(payload)) {
        event.preventDefault()
        try {
          await (navigator as Navigator).share(payload)
          return
        } catch (error) {
          // `AbortError` = user dismissed the native sheet. Silently fall
          // back to the dropdown so they still have a way forward.
          const name = (error as { name?: string } | null)?.name
          if (name !== "AbortError") {
            setOpen(true)
          }
          return
        }
      }

      // No Web Share support — let the DropdownMenuTrigger handle opening.
    },
    [onTriggerClick, post],
  )

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    pointerStartRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollY: typeof window === "undefined" ? 0 : window.scrollY,
    }
    suppressNextClickRef.current = false
  }, [])

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const start = pointerStartRef.current
    if (!start) return
    const scrolled = typeof window !== "undefined" ? Math.abs(window.scrollY - start.scrollY) : 0
    const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y)
    if (moved > SCROLL_CLICK_THRESHOLD_PX || scrolled > SCROLL_CLICK_THRESHOLD_PX) {
      suppressNextClickRef.current = true
    }
  }, [])

  const handlePointerCancel = React.useCallback(() => {
    pointerStartRef.current = null
    suppressNextClickRef.current = true
  }, [])

  const payload = React.useMemo(() => buildSharePayload(post), [post])

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className={cn(
            "h-12 w-full rounded-none justify-center text-muted-foreground",
            className,
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerCancel={handlePointerCancel}
          onClick={handleTriggerClick}
          aria-label="Share post"
        >
          <Share2 className="h-4 w-4 mr-2" />
          Share
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56" sideOffset={4}>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            void handleCopy(payload)
            setOpen(false)
          }}
        >
          <LinkIcon />
          <span className="ml-2">Copy link</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {PLATFORMS.map((platform) => (
          <DropdownMenuItem
            key={platform.key}
            onSelect={(event) => {
              event.preventDefault()
              const target = platform.buildUrl(payload)
              if (platform.key === "email") {
                // `mailto:` must go through location, not a popup, or
                // browsers block it as an invalid navigation target.
                if (typeof window !== "undefined") window.location.href = target
              } else {
                openShareWindow(target)
              }
              setOpen(false)
            }}
          >
            {platform.icon}
            <span className="ml-2">{platform.label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
