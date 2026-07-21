/**
 * Cross-component GPU status bus.
 *
 * The bottom-left GpuStatusBadge and the voice-settings control live in
 * different parts of the React tree and each poll /api/autobot/gpu on
 * their own timer — so between polls they could disagree. This tiny
 * window-event bus keeps them in lockstep: whenever EITHER fetches a
 * fresh status it publishes the raw payload, and both adopt it
 * immediately; a "refresh" ping after any start/stop makes both refetch
 * at once instead of waiting out their intervals.
 */

const STATUS_EVENT = "rivr:gpu-status";
const REFRESH_EVENT = "rivr:gpu-refresh";

/** Publish a freshly-fetched status payload to all listeners. */
export function publishGpuStatus(payload: unknown): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: payload }));
}

/** Subscribe to status payloads published by the other component. */
export function subscribeGpuStatus(
  handler: (payload: unknown) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => handler((event as CustomEvent).detail);
  window.addEventListener(STATUS_EVENT, listener);
  return () => window.removeEventListener(STATUS_EVENT, listener);
}

/** Ask every component to refetch now (call after a start/stop action). */
export function requestGpuRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REFRESH_EVENT));
}

/** Subscribe to refresh requests. */
export function subscribeGpuRefresh(handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(REFRESH_EVENT, handler);
  return () => window.removeEventListener(REFRESH_EVENT, handler);
}
