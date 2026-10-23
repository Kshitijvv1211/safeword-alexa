import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// Household policy. Everything the gate decides is driven by this object, so a
// family can tune it without touching code (via the update_policy MCP tool).

export const RoleSchema = z.enum(['adult', 'child', 'elder', 'unknown']);

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');

export const PolicySchema = z.object({
  household: z.string(),
  currency: z.string().default('USD'),
  members: z.record(z.string(), z.object({
    name: z.string(),
    role: RoleSchema,
    passcode_hash: z.string().optional(),
  })),
  purchases: z.object({
    auto_approve_limit: z.number().nonnegative(),
    hard_block_above: z.number().nonnegative(),
    blocked_categories: z.array(z.string()),
    children_can_purchase: z.boolean(),
    anomaly_multiplier: z.number().min(1),
  }),
  transfers: z.object({
    auto_approve_limit: z.number().nonnegative(),
    hard_block_above: z.number().nonnegative(),
    cooling_off_minutes: z.number().int().nonnegative(),
    caregiver: z.string(),
  }),
  access: z.object({
    unlock_roles: z.array(RoleSchema),
    unknown_voice_when_away: z.enum(['block', 'confirm']),
  }),
  quiet_hours: z.object({ start: HHMM, end: HHMM }),
  velocity: z.object({
    window_minutes: z.number().int().positive(),
    max_actions: z.number().int().positive(),
  }).default({ window_minutes: 10, max_actions: 5 }),
  checkout: z.object({
    max_drift_pct: z.number().nonnegative(),
    block_drift_pct: z.number().nonnegative(),
    duplicate_window_minutes: z.number().int().positive(),
  }).default({ max_drift_pct: 10, block_drift_pct: 30, duplicate_window_minutes: 10 }),
  safe_word: z.object({
    question: z.string(),
    answer_hash: z.string(),
    min_transfer: z.number().nonnegative(),
  }).optional(),
  trusted_servers: z.array(z.string()),
});

/** Fields a caller may change through update_policy / simulate_policy. Members and passcodes are not editable by voice. */
export const PolicyPatchSchema = z.object({
  purchases: PolicySchema.shape.purchases.partial().optional(),
  transfers: PolicySchema.shape.transfers.omit({ caregiver: true }).partial().optional(),
  access: PolicySchema.shape.access.partial().optional(),
  quiet_hours: PolicySchema.shape.quiet_hours.partial().optional(),
  velocity: z.object({ window_minutes: z.number().int().positive(), max_actions: z.number().int().positive() }).partial().optional(),
  checkout: z.object({ max_drift_pct: z.number().nonnegative(), block_drift_pct: z.number().nonnegative(), duplicate_window_minutes: z.number().int().positive() }).partial().optional(),
}).strict();

export function hashPasscode(passcode, salt = randomBytes(16).toString('hex')) {
  const digest = scryptSync(String(passcode), salt, 32).toString('hex');
  return `scrypt$${salt}$${digest}`;
}

export function checkPasscode(passcode, stored) {
  if (!stored || passcode == null) return false;
  const [, salt, digest] = stored.split('$');
  const candidate = scryptSync(String(passcode), salt, 32);
  const expected = Buffer.from(digest, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function defaultPolicy({ adultPasscode = '4321', caregiverPasscode = '2468' } = {}) {
  return PolicySchema.parse({
    household: 'The Rivera household',
    currency: 'USD',
    members: {
      alex: { name: 'Alex', role: 'adult', passcode_hash: hashPasscode(caregiverPasscode) },
      sam: { name: 'Sam', role: 'adult', passcode_hash: hashPasscode(adultPasscode) },
      mia: { name: 'Mia', role: 'child' },
      grandpa: { name: 'Grandpa Joe', role: 'elder', passcode_hash: hashPasscode('1111') },
    },
    purchases: {
      auto_approve_limit: 50,
      hard_block_above: 2000,
      blocked_categories: ['gift_cards', 'crypto'],
      children_can_purchase: false,
      anomaly_multiplier: 3,
    },
    transfers: {
      auto_approve_limit: 25,
      hard_block_above: 5000,
      cooling_off_minutes: 60,
      caregiver: 'alex',
    },
    access: {
      unlock_roles: ['adult', 'elder'],
      unknown_voice_when_away: 'block',
    },
    quiet_hours: { start: '22:00', end: '07:00' },
    // The family's spoken safe word, asked when a voice might be cloned (big transfers to new people).
    safe_word: { question: "What is the name of Grandpa's first dog?", answer_hash: hashPasscode(normalizeAnswer('Biscuit')), min_transfer: 100 },
    trusted_servers: ['freshcart', 'lockwise', 'quickpay'],
  });
}

/** Safe-word answers are compared case- and punctuation-insensitively ("biscuit!" = "Biscuit"). */
export function normalizeAnswer(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function applyPatch(policy, patch) {
  const p = PolicyPatchSchema.parse(patch);
  return PolicySchema.parse({
    ...policy,
    purchases: { ...policy.purchases, ...p.purchases },
    transfers: { ...policy.transfers, ...p.transfers },
    access: { ...policy.access, ...p.access },
    quiet_hours: { ...policy.quiet_hours, ...p.quiet_hours },
    velocity: { ...policy.velocity, ...p.velocity },
    checkout: { ...policy.checkout, ...p.checkout },
  });
}

/** Policy as shown to clients: passcode hashes stripped. */
export function publicPolicy(policy) {
  const members = Object.fromEntries(
    Object.entries(policy.members).map(([id, m]) => [id, { name: m.name, role: m.role, can_approve: Boolean(m.passcode_hash) && m.role === 'adult' }]),
  );
  const { safe_word, ...rest } = policy;
  return { ...rest, members, safe_word: safe_word ? { question: safe_word.question, min_transfer: safe_word.min_transfer, set: true } : { set: false } };
}
