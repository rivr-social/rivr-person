import { redirect } from "next/navigation";

/**
 * Sovereign index redirect. This app has no standalone `/marketplace` list
 * surface (detail pages live under `/marketplace/[id]`), but the sitemap
 * advertises `/marketplace` and the CommandBar targets it — a bare hit
 * previously 404'd. The home feed reads a `tab` query param, so forward to the
 * home Mart tab.
 */
export default function MarketplaceIndexPage() {
  redirect("/?tab=marketplace");
}
