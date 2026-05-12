/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * The Node-only work lives in `instrumentation-node.ts`. We dynamic-import it
 * inside a `NEXT_RUNTIME === "nodejs"` guard so Edge runtime never tries to
 * bundle `postgres`, `fs`, etc.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
