/**
 * Tests for `src/lib/recovery-seed.ts`.
 *
 * Coverage goals:
 * - mnemonic generation produces a valid 24-word BIP-39 phrase
 * - validator rejects wrong length, non-wordlist words, and bad checksum
 * - deterministic key derivation: same mnemonic → same public key + fingerprint
 * - different mnemonics produce different public keys
 * - fingerprint sync/async helpers agree
 * - word-N pick is deterministic and in range
 * - split / indexed-token helper shape
 * - InvalidMnemonicError surfaces a typed reason
 *
 * Verbose expectations ensure regressions pinpoint the exact invariant
 * that broke.
 */
import { describe, it, expect } from 'vitest';
import {
  InvalidMnemonicError,
  RECOVERY_FINGERPRINT_BYTES,
  RECOVERY_KEY_ALGORITHM,
  RECOVERY_MNEMONIC_STRENGTH_BITS,
  RECOVERY_MNEMONIC_WORD_COUNT,
  fingerprintFromPublicKey,
  fingerprintFromPublicKeySync,
  generateRecoveryMnemonic,
  mnemonicToRecoveryKeyPair,
  pickMnemonicConfirmationIndex,
  splitMnemonic,
  validateRecoveryMnemonic,
} from '../recovery-seed';

/**
 * Well-known BIP-39 test vector (abandon × 23, art). 24 words, valid
 * checksum. Safe to ship in tests because it is the canonical BIP-39
 * example phrase used across the ecosystem.
 */
const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

describe('recovery-seed constants', () => {
  it('uses a 256-bit / 24-word mnemonic (the sovereign default)', () => {
    expect(RECOVERY_MNEMONIC_STRENGTH_BITS).toBe(256);
    expect(RECOVERY_MNEMONIC_WORD_COUNT).toBe(24);
  });

  it('advertises ed25519 + 8-byte fingerprint', () => {
    expect(RECOVERY_KEY_ALGORITHM).toBe('ed25519');
    expect(RECOVERY_FINGERPRINT_BYTES).toBe(8);
  });
});

describe('generateRecoveryMnemonic / validateRecoveryMnemonic', () => {
  it('generates a mnemonic that itself validates', () => {
    const mnemonic = generateRecoveryMnemonic();
    expect(mnemonic.split(/\s+/).length).toBe(RECOVERY_MNEMONIC_WORD_COUNT);
    expect(validateRecoveryMnemonic(mnemonic)).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(validateRecoveryMnemonic('')).toBe(false);
    expect(validateRecoveryMnemonic('   ')).toBe(false);
  });

  it('rejects a 12-word mnemonic (wrong length for sovereign keys)', () => {
    const twelve =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(twelve.split(/\s+/).length).toBe(12);
    expect(validateRecoveryMnemonic(twelve)).toBe(false);
  });

  it('rejects a non-wordlist word', () => {
    const bad = FIXTURE_MNEMONIC.replace('art', 'notAWord');
    expect(validateRecoveryMnemonic(bad)).toBe(false);
  });

  it('rejects a mnemonic with invalid checksum', () => {
    // Swap the last word with a different valid wordlist word so the
    // checksum invariant is violated.
    const words = FIXTURE_MNEMONIC.split(' ');
    words[words.length - 1] = 'zoo';
    const tampered = words.join(' ');
    expect(validateRecoveryMnemonic(tampered)).toBe(false);
  });

  it('accepts the canonical abandon-art fixture', () => {
    expect(validateRecoveryMnemonic(FIXTURE_MNEMONIC)).toBe(true);
  });
});

describe('splitMnemonic', () => {
  it('returns 1-based indexed tokens matching word count', () => {
    const tokens = splitMnemonic(FIXTURE_MNEMONIC);
    expect(tokens.length).toBe(RECOVERY_MNEMONIC_WORD_COUNT);
    expect(tokens[0]).toEqual({ index: 1, word: 'abandon' });
    expect(tokens[tokens.length - 1]).toEqual({
      index: RECOVERY_MNEMONIC_WORD_COUNT,
      word: 'art',
    });
  });

  it('throws InvalidMnemonicError("empty") on blank input', () => {
    expect(() => splitMnemonic('')).toThrow(InvalidMnemonicError);
    try {
      splitMnemonic('   ');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMnemonicError);
      expect((err as InvalidMnemonicError).reason).toBe('empty');
    }
  });
});

describe('pickMnemonicConfirmationIndex', () => {
  it('returns an index strictly between 1 and WORD_COUNT', () => {
    const idx = pickMnemonicConfirmationIndex(FIXTURE_MNEMONIC);
    expect(idx).toBeGreaterThanOrEqual(2);
    expect(idx).toBeLessThan(RECOVERY_MNEMONIC_WORD_COUNT);
  });

  it('is deterministic for a given mnemonic', () => {
    const a = pickMnemonicConfirmationIndex(FIXTURE_MNEMONIC);
    const b = pickMnemonicConfirmationIndex(FIXTURE_MNEMONIC);
    expect(a).toBe(b);
  });

  it('throws InvalidMnemonicError on bad input', () => {
    expect(() => pickMnemonicConfirmationIndex('nope')).toThrow(InvalidMnemonicError);
  });
});

describe('mnemonicToRecoveryKeyPair', () => {
  it('derives deterministic public keys + fingerprints for a given mnemonic', async () => {
    const a = await mnemonicToRecoveryKeyPair(FIXTURE_MNEMONIC);
    const b = await mnemonicToRecoveryKeyPair(FIXTURE_MNEMONIC);
    expect(a.publicKeyHex).toBe(b.publicKeyHex);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.algorithm).toBe('ed25519');
    expect(a.publicKeyEncoding).toBe('hex');
    expect(a.fingerprintEncoding).toBe('base58btc');
    // 32-byte ed25519 pubkey → 64 hex chars.
    expect(a.publicKeyHex.length).toBe(64);
    expect(/^[0-9a-f]+$/.test(a.publicKeyHex)).toBe(true);
  });

  it('produces a different public key for a different mnemonic', async () => {
    const a = await mnemonicToRecoveryKeyPair(FIXTURE_MNEMONIC);
    const fresh = generateRecoveryMnemonic();
    const b = await mnemonicToRecoveryKeyPair(fresh);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('surfaces InvalidMnemonicError on bad mnemonic', async () => {
    await expect(mnemonicToRecoveryKeyPair('not a valid mnemonic')).rejects.toBeInstanceOf(
      InvalidMnemonicError,
    );
  });
});

describe('fingerprintFromPublicKey sync vs async', () => {
  it('sync and async helpers return the same value', async () => {
    const { publicKeyHex } = await mnemonicToRecoveryKeyPair(FIXTURE_MNEMONIC);
    const a = await fingerprintFromPublicKey(publicKeyHex);
    const b = fingerprintFromPublicKeySync(publicKeyHex);
    expect(a).toBe(b);
  });

  it('throws TypeError on malformed hex', () => {
    expect(() => fingerprintFromPublicKeySync('nothex!')).toThrow(TypeError);
  });
});
