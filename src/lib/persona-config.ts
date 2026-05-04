/**
 * Persona character-creator constants and shared types.
 *
 * Lives outside the "use server" boundary so client components and other
 * server modules can import the value-level constants (VOICE_STYLE_OPTIONS,
 * PERSONA_SKILL_KEYS, AutobotControlMode) without forcing the importer to
 * be a server action file.
 */

/** Voice/speaking style values offered to the persona creator. */
export const VOICE_STYLE_OPTIONS = [
  'terse',
  'warm',
  'formal',
  'technical',
  'playful',
] as const;
export type VoiceStyle = (typeof VOICE_STYLE_OPTIONS)[number];

/**
 * Canonical platform-skill keys persisted under `metadata.skills`.
 * Each value is a number in the inclusive range [0, 100].
 */
export const PERSONA_SKILL_KEYS = [
  'federationSavvy',
  'technicalDepth',
  'organizing',
  'publicVoice',
  'riskTolerance',
  'creativeOutput',
  'conversationalWarmth',
  'speed',
] as const;
export type PersonaSkillKey = (typeof PERSONA_SKILL_KEYS)[number];

export type AutobotControlMode = 'direct-only' | 'approval-required' | 'delegated';
