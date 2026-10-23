import { createHash } from 'node:crypto';

// MCP manifest guard: pin an MCP server's tool manifest, detect silent changes
// ("rug pulls"), and scan tool text for hidden instructions (tool poisoning).
// Dependency-free so it can ship on its own (see the mcp-manifest-guard package).

/** Stable JSON: sorted keys, so the hash never depends on key order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The parts of a tool that change what an agent will do with it. */
function toolFingerprint(t) {
  return { name: t.name, title: t.title, description: t.description ?? '', inputSchema: t.inputSchema ?? {}, outputSchema: t.outputSchema, annotations: t.annotations ?? {} };
}

/** Pin a manifest: one hash for the whole tool list plus one per tool, for diffs. */
export function pinManifest(tools) {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const perTool = Object.fromEntries(sorted.map((t) => [t.name, sha256(canonical(toolFingerprint(t)))]));
  return { hash: sha256(canonical(sorted.map(toolFingerprint))), tools: perTool };
}

/** Compare a pin with the current manifest. */
export function verifyManifest(pin, tools) {
  const now = pinManifest(tools);
  if (now.hash === pin.hash) return { ok: true, hash: now.hash, added: [], removed: [], changed: [] };
  const names = new Set([...Object.keys(pin.tools), ...Object.keys(now.tools)]);
  const diff = { added: [], removed: [], changed: [] };
  for (const n of names) {
    if (!(n in pin.tools)) diff.added.push(n);
    else if (!(n in now.tools)) diff.removed.push(n);
    else if (pin.tools[n] !== now.tools[n]) diff.changed.push(n);
  }
  return { ok: false, hash: now.hash, pinned_hash: pin.hash, ...diff };
}

const RULES = [
  { kind: 'instruction_override', re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|all)\b.{0,20}\b(instructions?|rules|prompts?)\b/i },
  { kind: 'hidden_from_user', re: /\bdo\s*n[o']t\s+(tell|mention|inform|show|reveal)\b.{0,25}\b(user|customer|anyone)\b/i },
  { kind: 'cross_tool_call', re: /\b(also|then|first|afterwards?)\s+(call|invoke|use|run|buy|order|send|purchase)\b/i },
  { kind: 'tool_reference', re: /\b[a-z0-9]+__[a-z0-9_]+\b/i },
  { kind: 'fake_tags', re: /<\/?\s*(important|system|instructions?|secret|admin)\s*>/i },
  { kind: 'credential_grab', re: /\b(api[_ -]?key|password|passcode|token|secret|ssh|credit card)\b.{0,40}\b(send|include|pass|add|read|share)\b/i },
  { kind: 'invisible_unicode', re: /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u },
  { kind: 'encoded_blob', re: /\b[A-Za-z0-9+/]{48,}={0,2}(?![A-Za-z0-9+/=])/ },
  { kind: 'url_in_tool_text', re: /\bhttps?:\/\/[^\s"']+/i },
];

function scanString(text, where, findings) {
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) {
      const at = Math.max(0, m.index - 30);
      findings.push({ ...where, kind: r.kind, excerpt: text.slice(at, m.index + m[0].length + 30).replace(/[​-‏‪-‮⁠-⁤﻿]/g, '⟨invisible⟩') });
    }
  }
}

function walkSchema(schema, path, tool, findings) {
  if (!schema || typeof schema !== 'object') return;
  for (const key of ['description', 'title', 'default']) {
    if (typeof schema[key] === 'string') scanString(schema[key], { tool, field: `${path}.${key}` }, findings);
  }
  for (const [k, v] of Object.entries(schema.properties ?? {})) walkSchema(v, `${path}.properties.${k}`, tool, findings);
  if (schema.items) walkSchema(schema.items, `${path}.items`, tool, findings);
}

/** Scan tool names, titles, descriptions and schema text for poisoning patterns. */
export function scanTools(tools) {
  const findings = [];
  for (const t of tools) {
    for (const field of ['title', 'description']) {
      if (typeof t[field] === 'string') scanString(t[field], { tool: t.name, field }, findings);
    }
    walkSchema(t.inputSchema, 'inputSchema', t.name, findings);
  }
  return findings;
}

/** Scan a single piece of text (for a tool description you're about to approve). */
export function scanText(text) {
  const findings = [];
  scanString(text, { tool: null, field: 'text' }, findings);
  return findings;
}
