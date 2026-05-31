import { redirect } from "next/navigation"

/**
 * /events index redirect.
 *
 * No dedicated events listing page exists — events are displayed on the home
 * feed's Events tab. Redirect there (instead of the bare home feed) so that
 * navigating to /events lands on a surface that actually shows events.
 */
export default function EventsIndexPage() {
  redirect("/?tab=events")
}
