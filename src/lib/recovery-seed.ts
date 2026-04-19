/**
 * Recovery seed phrase utilities (BIP-39 + Ed25519).
 *
 * Purpose:
 * Provide a single, client-safe module that generates sovereign recovery
 * seed material, derives an Ed25519 keypair from that material, and
 * computes a stable fingerprint of the public key.
 *
 * Important privacy rule:
 * This module is intended to run in the browser during signup and during
 * settings-side reveal/rotate. The plaintext mnemonic and private key MUST
 * NEVER be transmitted to the server. Only the public key and its
 * fingerprint are safe to POST.
 *
 * Key exports:
 * - `RECOVERY_MNEMONIC_WORD_COUNT`       : 24-word mnemonic (256-bit entropy).
 * - `RECOVERY_MNEMONIC_STRENGTH_BITS`    : 256.
 * - `RECOVERY_KEY_ALGORITHM`             : 'ed25519'.
 * - `RECOVERY_PUBLIC_KEY_ENCODING`       : 'hex'.
 * - `RECOVERY_FINGERPRINT_ENCODING`      : 'base58btc'.
 * - `generateRecoveryMnemonic()`         : fresh 24-word mnemonic.
 * - `validateRecoveryMnemonic(mnemonic)` : checksum/word-list validator.
 * - `mnemonicToRecoveryKeyPair(m)`       : async, returns public+private+fp.
 * - `fingerprintFromPublicKey(pkHex)`    : async, returns base58 fingerprint.
 * - `pickMnemonicConfirmationIndex(m)`   : deterministic word-index picker.
 * - `splitMnemonic(m)`                   : splits into indexed tokens.
 * - `InvalidMnemonicError`               : typed error for bad input.
 *
 * Dependencies:
 * - `@scure/bip39` for BIP-39 mnemonic generation/validation and seed derivation.
 * - `@noble/ed25519` for Ed25519 public-key derivation.
 * - `@noble/hashes` for SHA-256 (fingerprint) and SHA-512 (ed25519 deps).
 *
 * References:
 * - HANDOFF 2026-04-19 "Recovery Plan" section 1.
 * - GitHub issue rivr-social/rivr-person#12.
 */

import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getPublicKeyAsync } from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { setHmacSha512Sync } from './recovery-seed-noble-setup';

// ---------------------------------------------------------------------------
// Public constants (no magic numbers; tests pin against these)
// ---------------------------------------------------------------------------

/** Entropy used for the mnemonic: 256 bits → 24 words. */
export const RECOVERY_MNEMONIC_STRENGTH_BITS = 256 as const;

/** Word count for a 256-bit BIP-39 mnemonic. */
export const RECOVERY_MNEMONIC_WORD_COUNT = 24 as const;

/** Algorithm label used in serialized public keys and event payloads. */
export const RECOVERY_KEY_ALGORITHM = 'ed25519' as const;

/** Encoding for the serialized public key. */
export const RECOVERY_PUBLIC_KEY_ENCODING = 'hex' as const;

/** Encoding for the fingerprint. Base58btc keeps it copy-pasteable. */
export const RECOVERY_FINGERPRINT_ENCODING = 'base58btc' as const;

/**
 * Domain-separation tag mixed into the seed → keypair derivation.
 * Pinning this string prevents collisions with other uses of the same
 * BIP-39 mnemonic (e.g. Bitcoin wallets, SSH keys) so a user who imports
 * a mnemonic into another product cannot accidentally reuse our key.
 */
export const RECOVERY_SEED_DOMAIN_TAG = 'rivr-recovery-ed25519-v1' as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a supplied mnemonic fails BIP-39 validation (bad word list,
 * bad checksum, or wrong length).
 */
export class InvalidMnemonicError extends Error {
  public readonly reason: 'length' | 'wordlist' | 'checksum' | 'empty';

  constructor(reason: 'length' | 'wordlist' | 'checksum' | 'empty', message?: string) {
    super(
      message ??
        `Invalid recovery mnemonic: ${reason}. Expected ${RECOVERY_MNEMONIC_WORD_COUNT} BIP-39 English words with valid checksum.`,
    );
    this.name = 'InvalidMnemonicError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Noble bootstrap
// ---------------------------------------------------------------------------
// Install the sync SHA-512 hook for `@noble/ed25519` v3 so any downstream
// code that later reaches for the synchronous signing API (for example on
// the server when emitting signed credential events) works without crashing
// with a confusing "hashes.sha512 not set" error. The async helpers we use
// here (`getPublicKeyAsync`) already work without it.
setHmacSha512Sync(null, sha512);

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Base58 alphabet (Bitcoin/IPFS variant). */
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode a byte array into base58btc (Bitcoin alphabet).
 *
 * Used for user-facing fingerprints so they can be copy-pasted without
 * confusable characters (no `0OIl`).
 *
 * @param bytes Raw bytes to encode.
 * @returns Base58 string representation.
 */
export function bytesToBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zero bytes — they map to leading '1's in base58.
  let leadingZeros = 0;
  for (; leadingZeros < bytes.length && bytes[leadingZeros] === 0; leadingZeros++);

  // Copy so we don't mutate the caller's buffer.
  const buf = Array.from(bytes);
  const out: number[] = [];

  for (let start = leadingZeros; start < buf.length; ) {
    let remainder = 0;
    for (let i = start; i < buf.length; i++) {
      const acc = remainder * 256 + buf[i];
      buf[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    out.push(remainder);
    if (buf[start] === 0) start++;
  }

  let result = '';
  for (let i = 0; i < leadingZeros; i++) result += BASE58_ALPHABET[0];
  for (let i = out.length - 1; i >= 0; i--) result += BASE58_ALPHABET[out[i]];
  return result;
}

/**
 * Convert a hex string to a Uint8Array. Accepts only lowercase/uppercase
 * hex digits; throws `TypeError` for invalid input so callers never
 * silently pass malformed keys around.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new TypeError('hexToBytes: input length must be even.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new TypeError(`hexToBytes: invalid hex byte at offset ${i * 2}.`);
    }
    out[i] = byte;
  }
  return out;
}

/** Convert a Uint8Array to lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mnemonic API
// ---------------------------------------------------------------------------

/**
 * Generate a fresh 24-word BIP-39 mnemonic suitable for use as a sovereign
 * recovery seed.
 *
 * @returns Space-separated mnemonic string.
 * @throws Propagates errors from the underlying BIP-39 implementation only
 *   when the runtime lacks a CSPRNG; otherwise returns a valid mnemonic.
 */
export function generateRecoveryMnemonic(): string {
  return generateMnemonic(wordlist, RECOVERY_MNEMONIC_STRENGTH_BITS);
}

/**
 * Validate a mnemonic against the BIP-39 English wordlist and checksum.
 *
 * @param mnemonic Space-separated candidate mnemonic.
 * @returns `true` iff the mnemonic has the expected word count and passes
 *   the BIP-39 checksum. Does not throw on invalid input.
 */
export function validateRecoveryMnemonic(mnemonic: string): boolean {
  const trimmed = mnemonic.trim();
  if (trimmed.length === 0) return false;
  const words = trimmed.split(/\s+/);
  if (words.length !== RECOVERY_MNEMONIC_WORD_COUNT) return false;
  return validateMnemonic(trimmed, wordlist);
}

/**
 * Split a mnemonic into `{ index, word }` tokens so UIs can render numbered
 * boxes (word 1, word 2, ...) without re-indexing each time.
 *
 * @param mnemonic Mnemonic string (validated by the caller).
 * @returns Indexed token list; indices are 1-based for display.
 * @throws {InvalidMnemonicError} When the mnemonic is empty.
 */
export function splitMnemonic(mnemonic: string): Array<{ index: number; word: string }> {
  const trimmed = mnemonic.trim();
  if (trimmed.length === 0) {
    throw new InvalidMnemonicError('empty', 'splitMnemonic: mnemonic is empty.');
  }
  return trimmed.split(/\s+/).map((word, i) => ({ index: i + 1, word }));
}

/**
 * Deterministically pick a mnemonic word index for the "re-enter word N"
 * confirmation step based on the mnemonic's own digest.
 *
 * Using a deterministic pick (rather than `Math.random`) means the same
 * mnemonic always asks for the same word within a single session, so
 * re-rendering the UI cannot change the challenge. It also avoids the
 * most common indices (1 and 24) where users tend to just glance and
 * misconfirm.
 *
 * @param mnemonic Candidate mnemonic.
 * @returns 1-based index within [2, WORD_COUNT-1].
 * @throws {InvalidMnemonicError} When the mnemonic fails validation.
 */
export function pickMnemonicConfirmationIndex(mnemonic: string): number {
  if (!validateRecoveryMnemonic(mnemonic)) {
    throw new InvalidMnemonicError('wordlist');
  }
  const digest = sha256(new TextEncoder().encode(mnemonic.trim()));
  const range = RECOVERY_MNEMONIC_WORD_COUNT - 2; // avoid index 1 and N
  const pick = digest[0] % range; // 0..range-1
  return pick + 2; // 2..N-1
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Shape returned by {@link mnemonicToRecoveryKeyPair}.
 *
 * Note: `privateKeyHex` is intentionally included so the signup UI can keep
 * it in memory long enough to display the mnemonic and derive a fingerprint
 * for comparison with what the server stored. Callers MUST NOT transmit
 * `privateKeyHex` over the network.
 */
export interface RecoveryKeyPair {
  /** Ed25519 public key (hex). Safe to send to the server. */
  publicKeyHex: string;
  /**
   * Ed25519 "seed" (32 bytes, hex). Never transmit. Equivalent to the
   * private key in noble's API — feed back into signer to produce
   * signatures.
   */
  privateKeyHex: string;
  /** Base58btc fingerprint of the public key (copy-pasteable). */
  fingerprint: string;
  /** Algorithm identifier, for forward compatibility. */
  algorithm: typeof RECOVERY_KEY_ALGORITHM;
  /** Encoding used for `publicKeyHex`. */
  publicKeyEncoding: typeof RECOVERY_PUBLIC_KEY_ENCODING;
  /** Encoding used for `fingerprint`. */
  fingerprintEncoding: typeof RECOVERY_FINGERPRINT_ENCODING;
}

/**
 * Derive an Ed25519 keypair from a BIP-39 mnemonic using the
 * {@link RECOVERY_SEED_DOMAIN_TAG} to separate Rivr recovery keys from any
 * other product that might consume the same mnemonic.
 *
 * Derivation recipe:
 * 1. Run BIP-39 seed expansion on the mnemonic (empty passphrase).
 * 2. SHA-256 the seed together with the domain tag to get a 32-byte key.
 * 3. Treat that 32-byte value as an Ed25519 private-key seed and derive
 *    the corresponding public key via `@noble/ed25519.getPublicKeyAsync`.
 * 4. Fingerprint the public key with {@link fingerprintFromPublicKey}.
 *
 * @param mnemonic Validated BIP-39 mnemonic.
 * @returns Structured {@link RecoveryKeyPair}.
 * @throws {InvalidMnemonicError} When the mnemonic is invalid.
 *
 * @example
 * ```ts
 * const mnemonic = generateRecoveryMnemonic();
 * const { publicKeyHex, fingerprint } = await mnemonicToRecoveryKeyPair(mnemonic);
 * await fetch('/api/recovery/register', {
 *   method: 'POST',
 *   body: JSON.stringify({ publicKeyHex, fingerprint }),
 * });
 * ```
 */
export async function mnemonicToRecoveryKeyPair(mnemonic: string): Promise<RecoveryKeyPair> {
  if (!validateRecoveryMnemonic(mnemonic)) {
    throw new InvalidMnemonicError('wordlist');
  }
  // BIP-39 seed expansion uses PBKDF2(HMAC-SHA512, mnemonic, "mnemonic" + passphrase).
  const seed = await mnemonicToSeed(mnemonic.trim(), '');

  // Domain-separate the raw BIP-39 seed so the ed25519 seed we produce is
  // unique to Rivr recovery keys and unrelated to any other key material
  // derived from the same mnemonic.
  const domain = new TextEncoder().encode(RECOVERY_SEED_DOMAIN_TAG);
  const combined = new Uint8Array(domain.length + seed.length);
  combined.set(domain, 0);
  combined.set(seed, domain.length);
  const ed25519Seed = sha256(combined); // 32 bytes

  const publicKey = await getPublicKeyAsync(ed25519Seed);
  const publicKeyHex = bytesToHex(publicKey);
  const fingerprint = await fingerprintFromPublicKey(publicKeyHex);

  return {
    publicKeyHex,
    privateKeyHex: bytesToHex(ed25519Seed),
    fingerprint,
    algorithm: RECOVERY_KEY_ALGORITHM,
    publicKeyEncoding: RECOVERY_PUBLIC_KEY_ENCODING,
    fingerprintEncoding: RECOVERY_FINGERPRINT_ENCODING,
  };
}

/**
 * Number of SHA-256 bytes included in the fingerprint. 8 bytes (64 bits)
 * keeps the base58 string compact (~11 chars) while still providing enough
 * entropy that accidental collisions are astronomically unlikely for a
 * single user's key history.
 */
export const RECOVERY_FINGERPRINT_BYTES = 8 as const;

/**
 * Compute the user-visible fingerprint of a recovery public key.
 *
 * Recipe: base58btc(sha256(publicKeyBytes).slice(0, 8)).
 *
 * Server-side and client-side implementations must match exactly; tests
 * pin the output for a fixture mnemonic so drift is caught at review.
 *
 * @param publicKeyHex Public key bytes encoded as hex.
 * @returns Short base58btc fingerprint.
 * @throws {TypeError} When `publicKeyHex` is not valid hex.
 */
export async function fingerprintFromPublicKey(publicKeyHex: string): Promise<string> {
  const bytes = hexToBytes(publicKeyHex);
  const digest = sha256(bytes);
  return bytesToBase58(digest.slice(0, RECOVERY_FINGERPRINT_BYTES));
}

/**
 * Synchronous variant of {@link fingerprintFromPublicKey}. Exposed because
 * server-side validation code (Next.js API routes) can synchronously hash
 * without an async boundary, which simplifies request-body validation.
 *
 * @param publicKeyHex Public key bytes encoded as hex.
 * @returns Short base58btc fingerprint.
 */
export function fingerprintFromPublicKeySync(publicKeyHex: string): string {
  const bytes = hexToBytes(publicKeyHex);
  const digest = sha256(bytes);
  return bytesToBase58(digest.slice(0, RECOVERY_FINGERPRINT_BYTES));
}
