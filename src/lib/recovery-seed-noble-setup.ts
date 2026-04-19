/**
 * Idempotent setup helper for `@noble/ed25519` v3.
 *
 * v3 separates async and sync APIs: `getPublicKeyAsync` and `signAsync` use
 * Web Crypto and work out-of-the-box. The sync counterparts require
 * `hashes.sha512` to be set explicitly. We install that hook defensively
 * so downstream callers (for example any future code that signs recovery
 * events on the server) do not crash with a surprising "hashes.sha512 not
 * set" error.
 *
 * Key exports:
 * - `setHmacSha512Sync(_hmac, sha512)`  : idempotent installer, installs
 *                                           `hashes.sha512`. The `_hmac`
 *                                           argument is retained for API
 *                                           compatibility with the older
 *                                           noble v2 shape.
 *
 * Dependencies:
 * - `@noble/ed25519` (for the `hashes` object).
 */

import { hashes } from '@noble/ed25519';

type Sha512Like = (data: Uint8Array) => Uint8Array;

let installed = false;

/**
 * Install `hashes.sha512` once per process.
 *
 * The function signature accepts a placeholder first argument so callers
 * can pass the HMAC factory from `@noble/hashes/hmac` without the compiler
 * complaining — that HMAC factory is not actually required by v3, but
 * keeping the argument preserves a single call site between future
 * noble-major bumps.
 *
 * @param _hmac Unused in v3; kept for API stability.
 * @param sha512 SHA-512 hash function from `@noble/hashes/sha2`.
 * @returns Nothing. Safe to call repeatedly.
 */
export function setHmacSha512Sync(
  _hmac: unknown,
  sha512: Sha512Like,
): void {
  if (installed) return;

  // noble/ed25519 v3 expects `hashes.sha512` on the exported `hashes`
  // namespace. Assign defensively so re-imports don't overwrite an
  // already-installed hook.
  const slot = hashes as unknown as { sha512?: Sha512Like };
  if (!slot.sha512) {
    slot.sha512 = sha512;
  }
  installed = true;
}
