"use client"

/**
 * BottomNav component for federation-aware mobile navigation.
 *
 * 4-item layout:
 * - Home (local)
 * - Map (links to global instance)
 * - Create (local, scope-aware)
 * - Profile (local — routes to the active persona's public profile when one is
 *   active, otherwise to `/profile` for the controller).
 *
 * Builder and Autobot are accessed from the Profile page or Command Bar.
 */

import { useEffect, useState } from "react"
import { Home, Map, PlusSquare, User } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { getGlobalUrl } from "@/lib/federation/global-url"
import { getActivePersonaInfo } from "@/app/actions/personas"

/**
 * Renders fixed bottom navigation with federation-aware routing.
 * Map links to the global instance; other items stay local.
 */
export function BottomNav() {
  const pathname = usePathname()

  const globalMapUrl = getGlobalUrl("/map")

  // Mirror the persona-banner pattern: read the active-persona cookie via a
  // server action and route the profile button to the persona's public
  // profile when one is active. Falling back to `/profile` keeps the
  // controller's experience unchanged when no persona is active.
  const [profileHref, setProfileHref] = useState<string>("/profile")
  useEffect(() => {
    let cancelled = false
    getActivePersonaInfo()
      .then((info) => {
        if (cancelled) return
        if (info.active && info.persona) {
          const meta =
            info.persona.metadata && typeof info.persona.metadata === "object"
              ? (info.persona.metadata as Record<string, unknown>)
              : {}
          const username = typeof meta.username === "string" ? meta.username : ""
          setProfileHref(`/profile/${username || info.persona.id}`)
        } else {
          setProfileHref("/profile")
        }
      })
      .catch(() => {
        if (!cancelled) setProfileHref("/profile")
      })
    return () => {
      cancelled = true
    }
  }, [pathname])

  const navItems = [
    { name: "Home", href: "/", icon: Home, active: pathname === "/", external: false },
    { name: "Map", href: globalMapUrl, icon: Map, active: false, external: true },
    { name: "Create", href: "/create", icon: PlusSquare, active: pathname.startsWith("/create"), external: false },
    { name: "Profile", href: profileHref, icon: User, active: pathname.startsWith("/profile"), external: false },
  ]

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-40 bg-background border-t">
      <div className="flex justify-around items-center h-16">
        {navItems.map((item) =>
          item.external ? (
            <a
              key={item.name}
              href={item.href}
              rel="noopener noreferrer"
              className={cn(
                "flex flex-col items-center justify-center w-full h-full text-xs transition-colors",
                "text-muted-foreground hover:text-primary",
              )}
            >
              <item.icon className="h-6 w-6 mb-1" />
              <span className="sr-only">{item.name}</span>
            </a>
          ) : (
            <Link
              key={item.name}
              href={item.href}
              prefetch={false}
              className={cn(
                "flex flex-col items-center justify-center w-full h-full text-xs transition-colors",
                item.active ? "text-primary font-medium" : "text-muted-foreground hover:text-primary",
              )}
            >
              <item.icon className="h-6 w-6 mb-1" />
              <span className="sr-only">{item.name}</span>
            </Link>
          ),
        )}
      </div>
    </nav>
  )
}
