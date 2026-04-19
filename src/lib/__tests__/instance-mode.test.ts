/**
 * Tests for `src/lib/instance-mode.ts`.
 *
 * Coverage goals:
 * - happy paths for both sovereign and hosted-federated modes
 * - default mode when env var is missing or blank
 * - whitespace handling in env values
 * - invalid env values surface InvalidInstanceModeError with context
 * - type-guard correctness for unknown inputs
 * - in-process caching + explicit cache reset
 *
 * Verbose expectations are used so failures identify the exact branch
 * that regressed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_INSTANCE_MODE,
  INSTANCE_MODES,
  INSTANCE_MODE_ENV_VAR,
  INSTANCE_MODE_HOSTED_FEDERATED,
  INSTANCE_MODE_SOVEREIGN,
  InvalidInstanceModeError,
  getInstanceMode,
  isValidInstanceMode,
  resetInstanceModeCache,
} from '../instance-mode';

const originalEnv = process.env;

describe('instance-mode', () => {
  beforeEach(() => {
    // Reset env + cache between cases so ordering cannot leak state.
    process.env = { ...originalEnv };
    delete process.env[INSTANCE_MODE_ENV_VAR];
    resetInstanceModeCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetInstanceModeCache();
  });

  describe('constants', () => {
    it('exposes both legal modes in INSTANCE_MODES', () => {
      expect(INSTANCE_MODES).toEqual([
        'hosted-federated',
        'sovereign',
      ]);
    });

    it('defaults sovereign (matches rivr-person canonical deploy)', () => {
      expect(DEFAULT_INSTANCE_MODE).toBe(INSTANCE_MODE_SOVEREIGN);
    });

    it('exposes the env var name as a named constant', () => {
      expect(INSTANCE_MODE_ENV_VAR).toBe('RIVR_INSTANCE_MODE');
    });
  });

  describe('isValidInstanceMode', () => {
    it('accepts the sovereign literal', () => {
      expect(isValidInstanceMode(INSTANCE_MODE_SOVEREIGN)).toBe(true);
    });

    it('accepts the hosted-federated literal', () => {
      expect(isValidInstanceMode(INSTANCE_MODE_HOSTED_FEDERATED)).toBe(true);
    });

    it('rejects unknown strings', () => {
      expect(isValidInstanceMode('hosted')).toBe(false);
      expect(isValidInstanceMode('Sovereign')).toBe(false);
      expect(isValidInstanceMode('')).toBe(false);
    });

    it('rejects non-strings', () => {
      expect(isValidInstanceMode(undefined)).toBe(false);
      expect(isValidInstanceMode(null)).toBe(false);
      expect(isValidInstanceMode(42)).toBe(false);
      expect(isValidInstanceMode({ mode: 'sovereign' })).toBe(false);
    });
  });

  describe('getInstanceMode — default behavior', () => {
    it('returns sovereign when env var is unset', () => {
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });

    it('returns sovereign when env var is blank', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = '';
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });

    it('returns sovereign when env var is whitespace-only', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = '   \t\n ';
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });
  });

  describe('getInstanceMode — explicit values', () => {
    it('returns sovereign when explicitly configured', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_SOVEREIGN;
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });

    it('returns hosted-federated when explicitly configured', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_HOSTED_FEDERATED;
      expect(getInstanceMode()).toBe(INSTANCE_MODE_HOSTED_FEDERATED);
    });

    it('trims surrounding whitespace before validating', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = '  sovereign  ';
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });
  });

  describe('getInstanceMode — invalid values', () => {
    it('throws InvalidInstanceModeError for unknown values', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = 'federated';
      expect(() => getInstanceMode()).toThrow(InvalidInstanceModeError);
    });

    it('includes the offending value in the error', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = 'nonsense';
      let captured: unknown = null;
      try {
        getInstanceMode();
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(InvalidInstanceModeError);
      const err = captured as InvalidInstanceModeError;
      expect(err.received).toBe('nonsense');
      expect(err.allowed).toEqual(INSTANCE_MODES);
      expect(err.message).toContain('RIVR_INSTANCE_MODE');
      expect(err.message).toContain('"nonsense"');
      expect(err.message).toContain('"sovereign"');
      expect(err.message).toContain('"hosted-federated"');
    });

    it('is case-sensitive — "Sovereign" is rejected', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = 'Sovereign';
      expect(() => getInstanceMode()).toThrow(InvalidInstanceModeError);
    });
  });

  describe('getInstanceMode — caching', () => {
    it('caches the resolved value for the process lifetime', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_HOSTED_FEDERATED;
      expect(getInstanceMode()).toBe(INSTANCE_MODE_HOSTED_FEDERATED);

      // Mutating the env after first read should not change the cached
      // answer — mirrors real deploy behavior where env is frozen at boot.
      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_SOVEREIGN;
      expect(getInstanceMode()).toBe(INSTANCE_MODE_HOSTED_FEDERATED);
    });

    it('resetInstanceModeCache() forces re-read of env', () => {
      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_HOSTED_FEDERATED;
      expect(getInstanceMode()).toBe(INSTANCE_MODE_HOSTED_FEDERATED);

      process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_SOVEREIGN;
      resetInstanceModeCache();
      expect(getInstanceMode()).toBe(INSTANCE_MODE_SOVEREIGN);
    });
  });
});
