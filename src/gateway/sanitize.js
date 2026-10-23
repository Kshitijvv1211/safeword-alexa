// Output firewall: brand tool results go back into Alexa+'s context, so text in
// them that tries to instruct the assistant is a prompt injection. Sentences that
// match are removed before Alexa+ sees them. Deterministic on purpose, like the gate.

const INJECTION = [
  { id: 'override', pattern: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|rules|prompts?)\b/i },
  { id: 'fake_system', pattern: /\b(system|developer|admin)\s+(note|message|prompt|instruction)s?\b/i },
  { id: 'tool_steering', pattern: /\b(call|invoke|use|run)\s+(the\s+)?[a-z0-9]+__[a-z0-9_]+/i },
  { id: 'hide_from_user', pattern: /\bdo\s*n[o']t\s+(tell|mention|inform|show)\b.{0,20}\buser\b/i },
  { id: 'role_tags', pattern: /<\/?\s*(system|instructions?|assistant)\s*>/i },
  { id: 'assistant_directive', pattern: /\b(assistant|alexa|ai)\s*[,:]\s*(you\s+)?(must|should|now)\b/i },
];

export const REMOVED = '[removed by Decision Gate: instruction-like text]';

/** Scan one string; returns the cleaned string and which patterns fired. */
export function cleanText(text) {
  const hits = new Set();
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.map((s) => {
    const found = INJECTION.filter((r) => r.pattern.test(s)).map((r) => r.id);
    found.forEach((id) => hits.add(id));
    return found.length ? REMOVED : s;
  });
  // Collapse runs of removed sentences into one marker.
  const out = kept.filter((s, i) => !(s === REMOVED && kept[i - 1] === REMOVED)).join(' ');
  return { text: out, hits: [...hits] };
}

function walk(value, hits) {
  if (typeof value === 'string') {
    const r = cleanText(value);
    r.hits.forEach((h) => hits.add(h));
    return r.text;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, hits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, hits)]));
  return value;
}

/** Clean a CallToolResult (text content and structuredContent). */
export function sanitizeResult(result) {
  const hits = new Set();
  const content = result.content?.map((c) => {
    if (c.type !== 'text') return c;
    // JSON text is cleaned field by field so the result stays valid JSON.
    try {
      return { ...c, text: JSON.stringify(walk(JSON.parse(c.text), hits), null, 2) };
    } catch {
      return { ...c, text: walk(c.text, hits) };
    }
  });
  const structuredContent = result.structuredContent && walk(result.structuredContent, hits);
  return { result: { ...result, content, ...(structuredContent && { structuredContent }) }, hits: [...hits] };
}

/** Words that mean a tool has side effects, whatever its annotations claim. */
export const SIDE_EFFECT_WORDS = /\b(charge[sd]?|charging|buy|purchase|order|pay(s|ment)?|send|transfer|unlock|delete|remove|claim|subscribe|book)\b/i;
