/**
 * Client-side passphrase-encrypted mnemonic storage.
 *
 * Purpose:
 * Let the user optionally stash their recovery mnemonic on *this device*,
 * encrypted with a passphrase they choose, so the Settings > Security
 * "Reveal seed" flow can decrypt and re-surface it after a fresh MFA
 * challenge.
 *
 * Critical invariants:
 * - The passphrase and the plaintext mnemonic NEVER leave the browser.
 *   The server only ever receives the public key and fingerprint.
 * - Encryption is AES-GCM with a key derived from the passphrase via
 *   PBKDF2-SHA-256 (250k iterations). Parameters are stored alongside the
 *   ciphertext so the schema can evolve without breaking decryption.
 *
 * Key exports:
 * - `RECOVERY_LOCAL_STORAGE_KEY`     : well-known localStorage key.
 * - `RECOVERY_PBKDF2_ITERATIONS`     : 250_000.
 * - `storeEncryptedMnemonic()`       : encrypt + persist.
 * - `loadEncryptedMnemonicBlob()`    : read stored blob (no passphrase yet).
 * - `decryptMnemonic()`              : passphrase → plaintext mnemonic.
 * - `clearEncryptedMnemonic()`       : remove stored blob.
 * - `RecoverySeedLocalStoreError`    : typed error for decryption failures.
 *
 * Dependencies:
 * - Web Crypto (`crypto.subtle`). Works in the browser. Avoid importing
 *   this file from server-only code paths.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key under which the encrypted blob lives. */
export const RECOVERY_LOCAL_STORAGE_KEY = 'rivr.recovery.encrypted-mnemonic.v1';

/** PBKDF2 iteration count. OWASP 2023 floor for PBKDF2-SHA-256 is 600k;
 *  we use 250k as a pragmatic compromise for snappier reveal UX on older
 *  devices. Bump to 600k once we measure acceptable perf. */
export const RECOVERY_PBKDF2_ITERATIONS = 250_000;

/** Length of the PBKDF2 salt in bytes. */
export const RECOVERY_PBKDF2_SALT_BYTES = 16;

/** Length of the AES-GCM IV in bytes. 12 is standard for GCM. */
export const RECOVERY_AES_GCM_IV_BYTES = 12;

/** AES-GCM key size in bits. */
export const RECOVERY_AES_KEY_BITS = 256;

/** Schema version tag stamped onto every blob so future versions can migrate. */
export const RECOVERY_BLOB_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link decryptMnemonic} when the supplied passphrase is wrong
 * or the blob is malformed. Raised so callers can disambiguate from
 * SubtleCrypto system errors.
 */
export class RecoverySeedLocalStoreError extends Error {
  public readonly reason: 'missing' | 'malformed' | 'wrong_passphrase' | 'unsupported';
  constructor(reason: RecoverySeedLocalStoreError['reason'], message?: string) {
    super(
      message ??
        ({
          missing: 'No encrypted mnemonic is stored on this device.',
          malformed: 'Stored mnemonic blob is malformed.',
          wrong_passphrase: 'Passphrase could not decrypt the stored mnemonic.',
          unsupported:
            'Web Crypto is not available in this browser — encrypted local stash is disabled.',
        }[reason]),
    );
    this.name = 'RecoverySeedLocalStoreError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Blob shape
// ---------------------------------------------------------------------------

/**
 * On-disk shape of the encrypted blob. All binary fields are base64url so
 * the JSON stays compact and copy-pasteable for debug.
 */
export interface RecoveryEncryptedMnemonicBlob {
  version: typeof RECOVERY_BLOB_VERSION;
  /** Fingerprint of the public key the mnemonic corresponds to. */
  fingerprint: string;
  kdf: {
    algorithm: 'PBKDF2';
    hash: 'SHA-256';
    iterations: number;
    /** base64url(salt bytes). */
    salt: string;
  };
  cipher: {
    algorithm: 'AES-GCM';
    /** base64url(iv bytes). */
    iv: string;
    /** base64url(ciphertext || auth-tag). */
    ciphertext: string;
  };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new RecoverySeedLocalStoreError('unsupported');
  }
  return crypto.subtle;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    Math.ceil(b64.length / 4) * 4,
    '=',
  );
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await subtle().importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: salt as BufferSource },
    baseKey,
    { name: 'AES-GCM', length: RECOVERY_AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypt `mnemonic` under `passphrase` and store the blob in localStorage.
 *
 * Overwrites any existing blob at the canonical key — callers that need to
 * support multiple identities on one device should extend the storage key
 * scheme.
 *
 * @param mnemonic Plaintext BIP-39 mnemonic.
 * @param passphrase User-chosen passphrase. Never transmitted.
 * @param fingerprint Public-key fingerprint (owned by the mnemonic), so
 *   the UI can cross-check which account the blob belongs to.
 * @returns The persisted blob (minus secrets).
 */
export async function storeEncryptedMnemonic(
  mnemonic: string,
  passphrase: string,
  fingerprint: string,
): Promise<RecoveryEncryptedMnemonicBlob> {
  if (!mnemonic || !passphrase) {
    throw new RecoverySeedLocalStoreError('malformed', 'Both mnemonic and passphrase are required.');
  }
  if (typeof localStorage === 'undefined') {
    throw new RecoverySeedLocalStoreError('unsupported');
  }

  const salt = crypto.getRandomValues(new Uint8Array(RECOVERY_PBKDF2_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(RECOVERY_AES_GCM_IV_BYTES));
  const key = await deriveAesKey(passphrase, salt, RECOVERY_PBKDF2_ITERATIONS);

  const cipherBuf = await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(mnemonic),
  );

  const blob: RecoveryEncryptedMnemonicBlob = {
    version: RECOVERY_BLOB_VERSION,
    fingerprint,
    kdf: {
      algorithm: 'PBKDF2',
      hash: 'SHA-256',
      iterations: RECOVERY_PBKDF2_ITERATIONS,
      salt: bytesToBase64Url(salt),
    },
    cipher: {
      algorithm: 'AES-GCM',
      iv: bytesToBase64Url(iv),
      ciphertext: bytesToBase64Url(new Uint8Array(cipherBuf)),
    },
    createdAt: new Date().toISOString(),
  };

  localStorage.setItem(RECOVERY_LOCAL_STORAGE_KEY, JSON.stringify(blob));
  return blob;
}

/**
 * Load (but do not decrypt) the stored blob. Returns `null` if absent.
 */
export function loadEncryptedMnemonicBlob(): RecoveryEncryptedMnemonicBlob | null {
  if (typeof localStorage === 'undefined') return null;
  const raw = localStorage.getItem(RECOVERY_LOCAL_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryEncryptedMnemonicBlob>;
    if (parsed.version !== RECOVERY_BLOB_VERSION) return null;
    if (!parsed.fingerprint || !parsed.kdf || !parsed.cipher) return null;
    return parsed as RecoveryEncryptedMnemonicBlob;
  } catch {
    return null;
  }
}

/**
 * Decrypt the stored blob with `passphrase`.
 *
 * @returns The plaintext mnemonic.
 * @throws {RecoverySeedLocalStoreError} On missing / malformed / bad passphrase.
 */
export async function decryptMnemonic(passphrase: string): Promise<string> {
  const blob = loadEncryptedMnemonicBlob();
  if (!blob) throw new RecoverySeedLocalStoreError('missing');

  if (blob.version !== RECOVERY_BLOB_VERSION) {
    throw new RecoverySeedLocalStoreError('malformed', `Unsupported blob version ${blob.version}.`);
  }

  const salt = base64UrlToBytes(blob.kdf.salt);
  const iv = base64UrlToBytes(blob.cipher.iv);
  const ciphertext = base64UrlToBytes(blob.cipher.ciphertext);

  const key = await deriveAesKey(passphrase, salt, blob.kdf.iterations);

  let plain: ArrayBuffer;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource,
    );
  } catch {
    throw new RecoverySeedLocalStoreError('wrong_passphrase');
  }

  return new TextDecoder().decode(plain);
}

/** Remove the encrypted blob from localStorage. */
export function clearEncryptedMnemonic(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(RECOVERY_LOCAL_STORAGE_KEY);
}
