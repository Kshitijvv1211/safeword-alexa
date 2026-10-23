import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { PolicyPatchSchema, publicPolicy } from './policy.js';

// Plain-English rule changes. Amazon Bedrock turns "no electronics over $200 at night"
// into a structured policy patch; zod validates it; the gate dry-runs it; an adult must
// still approve it with update_policy. The model proposes, code checks, a person decides.
// Without Bedrock, a small phrase parser covers the common requests.

export const CATEGORIES = ['groceries', 'household', 'electronics', 'digital_games', 'gift_cards', 'crypto'];

const SYSTEM = [
  'You convert a household request about assistant shopping, payment or door rules into a policy change.',
  'Call the propose_changes tool exactly once. Only include fields that the request asks to change.',
  'Amounts are in US dollars. Times are 24-hour HH:MM. Categories must be from this list: ' + CATEGORIES.join(', ') + '.',
  'For blocked_categories, return the full new list (current list plus or minus what was asked).',
  'If the request cannot be expressed with the available fields, call the tool with empty changes and explain why in summary.',
].join(' ');

const TOOL_SCHEMA = (() => {
  const { $schema, ...changes } = z.toJSONSchema(PolicyPatchSchema, { io: 'input' });
  return {
    type: 'object',
    properties: {
      changes,
      summary: { type: 'string', description: 'One sentence describing the change in plain English.' },
    },
    required: ['changes', 'summary'],
  };
})();

const WORD_CATEGORY = [
  [/gift ?cards?/i, 'gift_cards'], [/crypto|bitcoin/i, 'crypto'], [/electronics?|gadgets?/i, 'electronics'],
  [/(video )?games?|game pass/i, 'digital_games'], [/groceries|grocery/i, 'groceries'], [/household/i, 'household'],
];

function hhmm(h, m, ampm) {
  let hour = Number(h) % 24;
  if (ampm?.toLowerCase() === 'pm' && hour < 12) hour += 12;
  if (ampm?.toLowerCase() === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(m ?? 0).padStart(2, '0')}`;
}

/** Offline fallback: deterministic phrase rules for the most common requests. */
export function parseRequest(text, policy) {
  const t = text.toLowerCase();
  const changes = {};
  const notes = [];
  let m;
  const money = /\$?\s?(\d+(?:\.\d+)?)/;
  if (/(transfer|send(ing)? money|payments?)/.test(t) && (m = t.match(/(?:limit|up to|over|above|under)\D{0,20}\$?\s?(\d+)/))) {
    changes.transfers = { auto_approve_limit: Number(m[1]) };
    notes.push(`auto-approve transfers up to $${m[1]}`);
  } else if (/(auto[- ]?approve|limit|up to)/.test(t) && (m = t.match(money))) {
    changes.purchases = { auto_approve_limit: Number(m[1]) };
    notes.push(`auto-approve purchases up to $${m[1]}`);
  }
  if ((m = t.match(/quiet hours?\D{0,10}(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|until|-)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/))) {
    changes.quiet_hours = { start: hhmm(m[1], m[2], m[3] ?? 'pm'), end: hhmm(m[4], m[5], m[6] ?? 'am') };
    notes.push(`quiet hours ${changes.quiet_hours.start}-${changes.quiet_hours.end}`);
  }
  const blocked = new Set(policy.purchases.blocked_categories);
  const blocking = /\b(block|ban|stop|no more|don'?t allow)\b/.test(t);
  const unblocking = /\b(unblock|allow|permit)\b/.test(t) && !blocking;
  if (blocking || unblocking) {
    for (const [re, cat] of WORD_CATEGORY) {
      if (re.test(t)) {
        blocking ? blocked.add(cat) : blocked.delete(cat);
        notes.push(`${blocking ? 'block' : 'allow'} ${cat.replace('_', ' ')}`);
      }
    }
    if (notes.some((n) => /^(block|allow) /.test(n))) changes.purchases = { ...changes.purchases, blocked_categories: [...blocked] };
  }
  if (/(kids|children|child)/.test(t) && /\b(buy|order|purchase|shop)\b/.test(t)) {
    const allow = /\b(let|allow|can)\b/.test(t) && !/\b(don'?t|do not|stop|no longer|can'?t)\b/.test(t);
    changes.purchases = { ...changes.purchases, children_can_purchase: allow };
    notes.push(allow ? 'children may buy' : 'children may not buy');
  }
  if (/(cool|hold|pause|scam)/.test(t) && (m = t.match(/(\d+)\s*(hours?|hrs?|minutes?|mins?)/))) {
    changes.transfers = { ...changes.transfers, cooling_off_minutes: Number(m[1]) * (/^h/.test(m[2]) ? 60 : 1) };
    notes.push(`Scam Shield hold ${changes.transfers.cooling_off_minutes} min`);
  }
  return { changes, summary: notes.length ? `Proposed: ${notes.join('; ')}.` : "I couldn't turn that into a rule change." };
}

export function createProposer({
  enabled = process.env.USE_BEDROCK === '1',
  modelId = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0',
  region = process.env.AWS_REGION || 'us-east-1',
  timeoutMs = Number(process.env.BEDROCK_TIMEOUT_MS || 8000),
  client,
} = {}) {
  const bedrock = enabled ? client ?? new BedrockRuntimeClient({ region }) : null;

  return async function propose(request, policy) {
    if (!bedrock) return { ...parseRequest(request, policy), source: 'rules' };
    const started = Date.now();
    try {
      const res = await bedrock.send(new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify({ request, current_policy: publicPolicy(policy) }) }] }],
        toolConfig: {
          tools: [{ toolSpec: { name: 'propose_changes', description: 'Propose a household policy change.', inputSchema: { json: TOOL_SCHEMA } } }],
          toolChoice: { any: {} },
        },
        inferenceConfig: { maxTokens: 400, temperature: 0 },
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      const use = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
      if (!use) throw new Error('no tool call in response');
      return { changes: use.input?.changes ?? {}, summary: use.input?.summary ?? '', source: 'bedrock', model: modelId, latency_ms: Date.now() - started };
    } catch (err) {
      return { ...parseRequest(request, policy), source: 'rules', bedrock_error: err.name || 'Error', bedrock_message: err.message };
    }
  };
}
