/**
 * @fileoverview EventDetailTabs - Client-side tab navigation for event detail page.
 *
 * Wraps the About, Attendees, Discussion, and Announcements tab content inside
 * a Radix Tabs component. Server-rendered HTML for each tab panel is passed
 * as children props from the parent server component; interactive feed
 * components (PostFeed, PeopleFeed, CommentFeed, CreatePost) are rendered
 * directly here since they require client-side state.
 */
"use client"

import { useState } from "react"
import { useSession } from "next-auth/react"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { CommentFeed } from "@/components/comment-feed"
import { CreatePost } from "@/components/create-post"
import type { EventAttendee } from "@/app/actions/interactions"

interface EventDetailTabsProps {
  /** The event id, passed through to scoped feed components. */
  eventId: string
  /** Pre-rendered event description HTML or text for the About tab. */
  description: string
  /** RSVP count displayed in the Attendees tab header. */
  rsvpCount: number
  /** List of attendees who have RSVP'd to the event. */
  attendees: EventAttendee[]
  /** Owner/creator id for admin-gated features (e.g. Announcements tab). */
  ownerId?: string
  sessionCount?: number
  hostCount?: number
  projectId?: string | null
  revenueCents?: number
  payoutTotalCents?: number
  remainingCents?: number
}

function formatCurrency(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100)
}

/**
 * Renders the four-tab interface on the event detail right column.
 *
 * About and Attendees panels display server-provided data.
 * Discussion panel lets attendees comment without the full post composer.
 * Announcements panel is admin-gated for organizer-only posts.
 *
 * @param props - Tab configuration with event context data.
 * @returns Four-panel tab interface for the event detail page.
 */
export function EventDetailTabs({
  eventId,
  description,
  rsvpCount,
  attendees,
  ownerId,
  sessionCount = 0,
  hostCount = 0,
  projectId = null,
  revenueCents = 0,
  payoutTotalCents = 0,
  remainingCents = 0,
}: EventDetailTabsProps) {
  const [activeTab, setActiveTab] = useState("about")
  const [eventAnnouncements, setEventAnnouncements] = useState<unknown[]>([])
  const { data: session } = useSession()
  const currentUserId = session?.user?.id
  const isAdmin = ownerId && currentUserId === ownerId

  const handlePostCreated = (newPost: unknown) => {
    setEventAnnouncements((prev) => [newPost, ...prev])
  }

  return (
    <div className="bg-background rounded-lg border overflow-hidden">
      <Tabs defaultValue="about" className="w-full" onValueChange={setActiveTab} value={activeTab}>
        <TabsList className="grid grid-cols-5 w-full rounded-none h-12">
          <TabsTrigger
            value="about"
            className="data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none"
          >
            About
          </TabsTrigger>
          <TabsTrigger
            value="attendees"
            className="data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none"
          >
            Attendees
          </TabsTrigger>
          <TabsTrigger
            value="discussion"
            className="data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none"
          >
            Discussion
          </TabsTrigger>
          <TabsTrigger
            value="announcements"
            className="data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none"
          >
            Announcements
          </TabsTrigger>
          <TabsTrigger
            value="financials"
            className="data-[state=active]:bg-transparent data-[state=active]:shadow-none rounded-none"
          >
            Financials
          </TabsTrigger>
        </TabsList>

        <div className="p-6">
          <TabsContent value="about" className="mt-0">
            <h2 className="text-2xl font-semibold mb-4">About Event</h2>
            <div className="prose max-w-none">
              <p className="whitespace-pre-wrap">{description}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-3 mt-6">
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Sessions</p>
                <p className="text-lg font-semibold">{sessionCount}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Hosts</p>
                <p className="text-lg font-semibold">{hostCount}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Project</p>
                {projectId ? (
                  <Link href={`/projects/${projectId}`} className="text-sm font-medium hover:underline">
                    Open linked project
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">No linked project</p>
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="attendees" className="mt-0">
            <h2 className="text-xl font-semibold mb-4">{rsvpCount} Going</h2>
            {attendees.length > 0 ? (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-4">
                {attendees.map((attendee) => (
                  <Link
                    key={attendee.id}
                    href={`/profile/${attendee.username || attendee.id}`}
                    className="flex flex-col items-center text-center group"
                  >
                    <Avatar className="h-14 w-14 border-2 border-border group-hover:ring-2 group-hover:ring-ring transition-shadow">
                      <AvatarImage src={attendee.avatar || "/placeholder.svg"} alt={attendee.name} />
                      <AvatarFallback>{attendee.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <p className="text-sm font-medium mt-1.5 truncate w-full">{attendee.name}</p>
                    {attendee.username ? (
                      <p className="text-xs text-muted-foreground truncate w-full">@{attendee.username}</p>
                    ) : null}
                    {attendee.status === "interested" ? (
                      <Badge variant="secondary" className="mt-1 text-[10px] px-1.5 py-0">Interested</Badge>
                    ) : null}
                  </Link>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">
                No RSVPs yet. Be the first to attend!
              </p>
            )}
          </TabsContent>

          <TabsContent value="discussion" className="mt-0">
            <h2 className="text-xl font-semibold mb-4">Discussion</h2>
            <CommentFeed eventId={eventId} />
          </TabsContent>

          <TabsContent value="announcements" className="mt-0">
            <h2 className="text-xl font-semibold mb-4">Announcements</h2>
            {isAdmin ? (
              <>
                <CreatePost eventId={eventId} onPostCreated={handlePostCreated} />
                {eventAnnouncements.length === 0 ? (
                  <p className="text-center py-8 text-muted-foreground">No announcements yet.</p>
                ) : (
                  <p className="text-center py-4 text-muted-foreground">
                    {eventAnnouncements.length} announcement{eventAnnouncements.length !== 1 ? "s" : ""} posted.
                  </p>
                )}
              </>
            ) : (
              <p className="text-center py-8 text-muted-foreground">
                Only event organizers can post announcements.
              </p>
            )}
          </TabsContent>

          <TabsContent value="financials" className="mt-0">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h2 className="text-xl font-semibold">Financials</h2>
                <p className="text-sm text-muted-foreground">Payouts, revenue, and remaining balance for this event.</p>
              </div>
              <Link href={`/events/${eventId}/financials`} className="text-sm font-medium hover:underline">
                Open financials
              </Link>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-4">
                <p className="text-sm text-muted-foreground">Revenue</p>
                <p className="text-xl font-semibold">{formatCurrency(revenueCents)}</p>
              </div>
              <div className="rounded-md border p-4">
                <p className="text-sm text-muted-foreground">Payouts</p>
                <p className="text-xl font-semibold">{formatCurrency(payoutTotalCents)}</p>
              </div>
              <div className="rounded-md border p-4">
                <p className="text-sm text-muted-foreground">Remaining</p>
                <p className="text-xl font-semibold">{formatCurrency(remainingCents)}</p>
              </div>
            </div>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  )
}
