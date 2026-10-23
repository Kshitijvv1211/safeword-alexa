import { z } from 'zod';
import { RoleSchema } from './policy.js';
import { scanForScam } from './scam.js';

// The decision engine is pure, deterministic code: same action + context + policy
// always gives the same verdict. No model is consulted, so no prompt can talk it
// past a household limit.

export const ActionSchema = z.object({
  type: z.enum(['purchase', 'transfer', 'unlock', 'secure', 'other']),
  description: z.string().default(''),
  amount: z.number().nonnegative().optional(),
  currency: z.string().optional(),
  merchant: z.string().optional(),
  category: z.string().optional(),
  item: z.string().optional(),
  quantity: z.number().int().positive().optional(),
  payee: z.string().optional(),
  door: z.string().optional(),
  server: z.string().optional(),
  tool: z.string().optional(),
  flags: z.array(z.string()).optional(),
  detail: z.string().optional(),
  checkout_phase: z.enum(['create', 'complete']).optional(),
});

export const ContextSchema = z.object({
  speaker: z.object({
    id: z.string().optional(),
    role: RoleSchema.default('unknown'),
  }).default({ role: 'unknown' }),
  utterance: z.string().default(''),
  local_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  home_occupied: z.boolean().optional(),
});

export const VERDICTS = ['allow', 'confirm', 'hold', 'block'];
const RANK = { note: 0, confirm: 1, hold: 2, block: 3 };
const FLOOR = { allow: 0, confirm: 40, hold: 75, block: 90 };

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function inQuietHours(hhmm, { start, end }) {
  if (!hhmm) return false;
  const t = minutesOf(hhmm), s = minutesOf(start), e = minutesOf(end);
  return s <= e ? t >= s && t < e : t >= s || t < e;
}

function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const ordinal = (n) => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
};

const money = (n, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);

/**
 * @param {z.input<typeof ActionSchema>} rawAction
 * @param {z.input<typeof ContextSchema>} rawContext
 * @param {object} policy household policy
 * @param {{purchases: Array<{merchant:string, category:string, amount:number}>, payees: string[]}} history
 * @param {{recent_actions?: number}} signals counts the gate derives from its own log
 */
export function evaluate(rawAction, rawContext, policy, history, signals = {}) {
  const action = ActionSchema.parse(rawAction);
  const context = ContextSchema.parse(rawContext ?? {});
  const role = context.speaker.role;
  const cur = action.currency ?? policy.currency;
  const quiet = inQuietHours(context.local_time, policy.quiet_hours);
  const factors = [];
  const add = (id, effect, weight, reason) => factors.push({ id, effect, weight, reason });
  let scam = { score: 0, hits: [] };

  if (action.type === 'purchase') {
    const p = policy.purchases;
    const amount = action.amount ?? 0;
    if (action.category && p.blocked_categories.includes(action.category)) {
      add('blocked_category', 'block', 60, `${action.category.replace('_', ' ')} are blocked by household rules`);
    }
    if (amount > p.hard_block_above) {
      add('over_hard_limit', 'block', 60, `${money(amount, cur)} is over the ${money(p.hard_block_above, cur)} hard limit`);
    }
    if (role === 'child' && !p.children_can_purchase) {
      add('child_purchase', 'block', 50, 'children cannot place orders in this household');
    }
    if (role === 'unknown') add('unknown_voice', 'confirm', 25, 'the voice was not recognised');
    if (amount > p.auto_approve_limit) {
      add('over_auto_limit', 'confirm', 25, `${money(amount, cur)} is over the ${money(p.auto_approve_limit, cur)} auto-approve limit`);
    }
    const known = history.purchases.some((h) => h.merchant === action.merchant);
    if (action.merchant && !known) add('new_merchant', 'confirm', 15, `${action.merchant} is a store this household has never used`);
    const usual = median(history.purchases.filter((h) => h.category === action.category).map((h) => h.amount));
    if (usual && amount >= usual * p.anomaly_multiplier) {
      add('price_anomaly', 'confirm', 20, `${money(amount, cur)} is ${(amount / usual).toFixed(1)}x what you usually spend on ${action.category}`);
    } else if (!usual && action.category && amount > p.auto_approve_limit) {
      add('first_in_category', 'note', 10, `first ever ${action.category} purchase`);
    }
    if ((action.quantity ?? 1) > 5) add('bulk_quantity', 'confirm', 10, `unusually large quantity (${action.quantity})`);
    // Checkout guard signals (from evaluate_checkout).
    const co = policy.checkout ?? { max_drift_pct: 10, block_drift_pct: 30 };
    if (signals.price_drift_pct != null && signals.price_drift_pct > co.max_drift_pct) {
      add('price_drift', signals.price_drift_pct > co.block_drift_pct ? 'block' : 'confirm', 30,
        `the total went from ${money(signals.created_total, cur)} to ${money(amount, cur)} (+${signals.price_drift_pct.toFixed(0)}%) between checkout and payment`);
    }
    if (signals.duplicate_minutes_ago != null) {
      add('duplicate_order', 'confirm', 25, `the same order from ${action.merchant} was placed ${signals.duplicate_minutes_ago < 1 ? 'less than a minute' : `${Math.round(signals.duplicate_minutes_ago)} minutes`} ago`);
    }
    if (quiet && amount > 0) add('quiet_hours', 'confirm', 10, `it is ${context.local_time}, inside quiet hours`);
  }

  if (action.type === 'transfer') {
    const t = policy.transfers;
    const amount = action.amount ?? 0;
    scam = scanForScam(context.utterance);
    if (role === 'child') add('child_transfer', 'block', 50, 'children cannot send money');
    if (amount > t.hard_block_above) add('over_hard_limit', 'block', 60, `${money(amount, cur)} is over the ${money(t.hard_block_above, cur)} transfer limit`);
    const newPayee = action.payee && !history.payees.includes(action.payee);
    if (newPayee) add('new_payee', 'confirm', 20, `${action.payee} has never been paid before`);
    if (amount > t.auto_approve_limit) add('over_auto_limit', 'confirm', 15, `${money(amount, cur)} is over the ${money(t.auto_approve_limit, cur)} transfer auto-approve limit`);
    if (role === 'unknown') add('unknown_voice', 'confirm', 25, 'the voice was not recognised');
    if (quiet) add('quiet_hours', 'confirm', 10, `it is ${context.local_time}, inside quiet hours`);
    // Safe word: a voice can be cloned from a few seconds of audio, so a big transfer to someone
    // new (or from an unrecognised voice) must be confirmed with the family's spoken safe word.
    const sw = policy.safe_word;
    if (sw && amount >= sw.min_transfer && (newPayee || role === 'unknown') && role !== 'child') {
      add('safe_word', 'confirm', 10, `big transfers to someone new need the family safe word, because voices can be cloned`);
    }
    // Scam Shield: strong scam language, or a vulnerable speaker sending to a stranger
    // with any scam signal, puts the money into a cooling-off hold only the caregiver can release.
    const vulnerable = role === 'elder' && newPayee && scam.score > 0;
    if (scam.score >= 50 || vulnerable) {
      add('scam_pattern', 'hold', scam.score, `this sounds like a known scam pattern: ${scam.hits.map((h) => h.label).join('; ')}`);
    } else if (scam.score > 0) {
      add('scam_signal', 'confirm', scam.score, `possible scam signal: ${scam.hits.map((h) => h.label).join('; ')}`);
    }
  }

  if (action.type === 'unlock') {
    const a = policy.access;
    const allowedRole = a.unlock_roles.includes(role);
    if (role === 'unknown') {
      if (context.home_occupied === false) {
        add('unknown_voice_away', a.unknown_voice_when_away, 60, 'an unrecognised voice asked to unlock while nobody is home');
      } else {
        add('unknown_voice', 'confirm', 35, 'the voice was not recognised');
      }
    } else if (!allowedRole) {
      add('role_not_allowed', 'confirm', 35, `${role}s need an adult to approve unlocking`);
    }
    if (quiet) add('quiet_hours', context.home_occupied === false ? 'confirm' : 'note', 15, `it is ${context.local_time}, inside quiet hours`);
    if (context.home_occupied === false && allowedRole) add('nobody_home', 'confirm', 15, 'the home reports nobody is in');
  }

  // Speed check: a burst of money actions suggests a hijacked session or a runaway agent loop.
  const velocity = policy.velocity ?? { window_minutes: 10, max_actions: 5 };
  const recent = signals.recent_actions ?? 0;
  if ((action.type === 'purchase' || action.type === 'transfer') && recent >= velocity.max_actions) {
    add('velocity', 'confirm', 20, `this is the ${ordinal(recent + 1)} order or payment from this voice in ${velocity.window_minutes} minutes`);
  }

  if (action.type === 'other') {
    const flags = action.flags ?? [];
    // Add-on integrity: a changed or poisoned manifest blocks every call to that add-on.
    if (flags.includes('addon_changed')) {
      add('addon_changed', 'block', 80, `${action.server} changed its tools after you approved it${action.detail ? ` (${action.detail})` : ''}; it's blocked until an adult re-approves it`);
    }
    if (flags.includes('hidden_instructions')) {
      add('hidden_instructions', 'block', 80, `${action.server}'s tool text contains hidden instructions${action.detail ? ` (${action.detail})` : ''}`);
    }
    if (flags.includes('annotation_mismatch')) {
      add('annotation_mismatch', 'block', 70, `${action.server ?? 'this server'} labels ${action.tool ?? 'this tool'} read-only, but it says it charges or changes things; mislabelled tools from untrusted servers are blocked`);
    }
    if (flags.includes('untrusted_server')) add('untrusted_server', 'confirm', 25, `${action.server ?? 'this server'} is not on the household's trusted list`);
    if (!flags.includes('addon_changed') && !flags.includes('hidden_instructions')) {
      add('unclassified_side_effect', 'confirm', 40, `${action.tool ?? 'this tool'} can change things and has no household rule yet`);
    }
  }

  const top = factors.reduce((m, f) => Math.max(m, RANK[f.effect]), 0);
  const verdict = top === 3 ? 'block' : top === 2 ? 'hold' : top === 1 ? 'confirm' : 'allow';
  const raw = factors.reduce((s, f) => s + f.weight, 0);
  const risk_score = Math.min(100, Math.max(raw, FLOOR[verdict]));
  const reasons = factors
    .filter((f) => verdict === 'allow' || f.effect !== 'note')
    .sort((x, y) => RANK[y.effect] - RANK[x.effect] || y.weight - x.weight)
    .map((f) => f.reason);

  return {
    verdict,
    risk_score,
    reasons,
    factors,
    challenge: verdict === 'confirm' && factors.some((f) => f.id === 'safe_word') ? 'safe_word' : undefined,
    scam: scam.score ? scam : undefined,
    say: verdict === 'confirm' && factors.some((f) => f.id === 'safe_word')
      ? `Before I ${sayWhat(action, cur)}, I need the family safe word. Voices can be copied, so this keeps your money safe.`
      : sayLine(verdict, action, reasons, policy, cur),
    action,
    context,
  };
}

function sayWhat(action, cur) {
  return action.type === 'unlock'
    ? `unlock the ${action.door ?? 'door'}`
    : action.type === 'transfer'
      ? `send ${money(action.amount ?? 0, cur)}${action.payee ? ` to ${action.payee}` : ''}`
      : action.type === 'purchase'
        ? `order ${action.item ?? 'that'}${action.amount ? ` for ${money(action.amount, cur)}` : ''}`
        : 'do that';
}

function sayLine(verdict, action, reasons, policy, cur) {
  const what = action.type === 'unlock'
    ? `unlock the ${action.door ?? 'door'}`
    : action.type === 'transfer'
      ? `send ${money(action.amount ?? 0, cur)}${action.payee ? ` to ${action.payee}` : ''}`
      : action.type === 'purchase'
        ? `order ${action.item ?? 'that'}${action.amount ? ` for ${money(action.amount, cur)}` : ''}`
        : `do that`;
  const why = reasons[0] ? `, because ${reasons[0]}` : '';
  switch (verdict) {
    case 'allow': return `Done. I went ahead and ${what.replace(/^order/, 'ordered').replace(/^send/, 'sent').replace(/^unlock/, 'unlocked')}.`;
    case 'confirm': return `I can ${what}, but I need an adult to approve it first${why}.`;
    case 'hold': {
      const caregiver = policy.members[policy.transfers.caregiver]?.name ?? 'your caregiver';
      return `I've paused this so you can take a breath${why}. I've let ${caregiver} know; it can only go out once they approve it.`;
    }
    default: return `I can't ${what}${why}.`;
  }
}
