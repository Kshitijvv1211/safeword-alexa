import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ElicitResultSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ActionSchema, ContextSchema } from '../gate/engine.js';
import { MAX_ATTEMPTS, SAFE_WORD_ATTEMPTS } from '../gate/gate.js';
import { PolicyPatchSchema } from '../gate/policy.js';
import { sanitizeResult } from '../gateway/sanitize.js';
import { scanText } from '../gateway/manifest-guard.js';

const INSTRUCTIONS = `Decision Gate is the household trust layer. Before Alexa+ buys, pays, or unlocks anything it calls a gated tool (or evaluate_action).
Always pass alexa_context: the recognised speaker (id + role), the words they said, local time HH:MM, and whether anyone is home.
Read the "say" field to the customer word for word. Never retry a blocked action with different wording.
If a confirmation is pending, an adult approves it (the gate asks via elicitation when the client supports it, otherwise use confirm_action).`;

const GATE_TOOLS = {
  evaluate_action: {
    title: 'Evaluate an action',
    description: 'Ask the gate whether a purchase, transfer, or door unlock should go ahead. Returns allow, confirm, hold or block with a risk score, reasons, and a line to say aloud. Does not execute anything.',
    input: z.object({ action: ActionSchema, alexa_context: ContextSchema.optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  confirm_action: {
    title: 'Approve a held action',
    description: 'Approve a pending confirmation with an adult (or, for Scam Shield holds, the caregiver) and their passcode. Single use, expires, locks after 3 failed tries. On success the original action runs.',
    input: z.object({ confirmation_id: z.string(), approver: z.string(), passcode: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  evaluate_checkout: {
    title: 'Check a checkout session',
    description: 'Check an Alexa+-style checkout session at Create or Complete, with its Idempotency-Key. On top of house rules: same key + same body replays the original decision (never re-run, never charged twice), same key + different body is rejected, a total that jumps between Create and Complete is held, and a duplicate order within minutes needs approval.',
    input: z.object({
      phase: z.enum(['create', 'complete']),
      idempotency_key: z.string().min(8),
      merchant: z.string(),
      session: z.object({
        id: z.string(),
        currency: z.string().default('USD'),
        line_items: z.array(z.object({
          item: z.object({ id: z.string(), title: z.string().optional(), price: z.number().nonnegative().optional(), category: z.string().optional() }),
          quantity: z.number().int().positive(),
        })).min(1),
        totals: z.array(z.object({ type: z.string(), amount: z.number() })).optional(),
      }),
      alexa_context: ContextSchema.optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  answer_challenge: {
    title: 'Answer the safe-word question',
    description: "Answer the family safe-word question for a pending request (asked when a big transfer goes to someone new, because voices can be cloned). Two wrong answers lock the request and alert every adult.",
    input: z.object({ confirmation_id: z.string(), answer: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  request_guardian_approval: {
    title: 'Ask the guardian',
    description: "Send a pending request to the household guardian's phone. From then on only the guardian can approve or deny it.",
    input: z.object({ confirmation_id: z.string(), note: z.string().max(200).optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  guardian_decide: {
    title: 'Guardian decision',
    description: 'The guardian approves (the action runs) or denies (closed for good) a pending request, with their passcode.',
    input: z.object({ confirmation_id: z.string(), guardian: z.string(), passcode: z.string(), decision: z.enum(['approve', 'deny']) }),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  set_safe_word_challenge: {
    title: 'Set the family safe word',
    description: 'Set the question and answer used to confirm big transfers to new people. Only a hash of the answer is stored. Needs an adult passcode (elicited if omitted).',
    input: z.object({ question: z.string().min(5).max(200), answer: z.string().min(2).max(100), min_transfer: z.number().nonnegative().optional(), approver: z.string().optional(), passcode: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  get_policy: {
    title: 'Read house rules',
    description: 'Return the household policy: limits, blocked categories, quiet hours, members and roles.',
    input: z.object({}),
    annotations: { readOnlyHint: true },
  },
  simulate_policy: {
    title: 'Dry-run a rule change',
    description: 'Replay recent real decisions under a proposed rule change and report which verdicts would flip. Changes nothing.',
    input: z.object({ changes: PolicyPatchSchema }),
    annotations: { readOnlyHint: true },
  },
  propose_policy_change: {
    title: 'Draft a rule change from plain English',
    description: 'Turn a request like "lower the auto-approve limit to $20 and block video games" into a validated policy change (Amazon Bedrock when enabled), with a dry-run of its impact. Changes nothing; apply it with update_policy.',
    input: z.object({ request: z.string().min(3).max(500) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  update_policy: {
    title: 'Change house rules',
    description: 'Change limits or rules. Requires an adult approver and passcode (asked via elicitation if omitted and supported). Returns the impact on recent decisions.',
    input: z.object({ changes: PolicyPatchSchema, approver: z.string().optional(), passcode: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  verify_addon: {
    title: 'Check an add-on for changes',
    description: "Compare an add-on's live tool manifest with the SHA-256 pin approved by the household, and scan its tool text for hidden instructions. Every forwarded call does this automatically.",
    input: z.object({ server: z.string() }),
    annotations: { readOnlyHint: true },
  },
  pin_addon: {
    title: 'Approve an add-on manifest',
    description: "Re-approve an add-on's current tools after reviewing a change. Needs an adult passcode (elicited if omitted). Refused if the tool text contains hidden instructions.",
    input: z.object({ server: z.string(), approver: z.string().optional(), passcode: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  scan_tool_text: {
    title: 'Scan tool text for poisoning',
    description: 'Scan a tool description (or every tool of an add-on) for hidden instructions: override phrases, "do not tell the user", cross-tool calls, fake tags, invisible Unicode, encoded blobs, URLs.',
    input: z.object({ server: z.string().optional(), text: z.string().optional() }),
    annotations: { readOnlyHint: true },
  },
  get_audit_log: {
    title: 'Read the audit log',
    description: 'Recent hash-chained audit entries, chain verification, pending approvals and caregiver notifications.',
    input: z.object({ limit: z.number().int().min(1).max(200).default(20), kind: z.enum(['decision', 'confirmation', 'execution', 'policy_update', 'notification', 'injection_blocked', 'addon_integrity', 'addon_pinned', 'checkout', 'challenge']).optional() }),
    annotations: { readOnlyHint: true },
  },
};

// MCP Apps (extension io.modelcontextprotocol/ui, spec 2026-01-26): hosts that support it
// render this card inline for any tool whose _meta.ui.resourceUri points at it.
export const DECISION_CARD_URI = 'ui://decision-gate/decision-card';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
const DECISION_CARD_HTML = readFileSync(new URL('./ui/decision-card.html', import.meta.url), 'utf8');
const CARD_META = { ui: { resourceUri: DECISION_CARD_URI } };
const CARD_TOOLS = new Set(['evaluate_action', 'evaluate_checkout']);

/** "purchases.auto_approve_limit: 20" style lines, readable when spoken or shown in an approval prompt. */
export function describeChanges(changes) {
  const parts = [];
  for (const [section, fields] of Object.entries(changes)) {
    for (const [key, value] of Object.entries(fields ?? {})) {
      const label = `${section === 'purchases' ? '' : `${section.replace('_', ' ')} `}${key.replace(/_/g, ' ')}`;
      parts.push(`${label} → ${Array.isArray(value) ? value.join(', ').replace(/_/g, ' ') : value}`);
    }
  }
  return parts.join('; ') || 'no changes';
}

const toJsonSchema = (schema) => {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: 'input' });
  return rest;
};

const reply = (value, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  ...(isError && { isError: true }),
});

const unwrap = (result) => result?.structuredContent ?? (result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : result);

/** One MCP Server per Alexa+ session; all sessions share the same gate and gateway. */
export function buildMcpServer(gate, gateway) {
  const server = new Server(
    { name: 'safeword-decision-gate', title: 'SafeWord for Alexa+', version: '1.1.0' },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: DECISION_CARD_URI,
      name: 'Decision card',
      description: 'Interactive verdict card: risk, reasons, and an approval form for held actions.',
      mimeType: MCP_APP_MIME,
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== DECISION_CARD_URI) throw new Error(`Unknown resource: ${req.params.uri}`);
    return { contents: [{ uri: DECISION_CARD_URI, mimeType: MCP_APP_MIME, text: DECISION_CARD_HTML, _meta: { ui: { prefersBorder: true } } }] };
  });

  const adults = () => Object.entries(gate.policy.members)
    .filter(([, m]) => m.role === 'adult' && m.passcode_hash)
    .map(([id, m]) => ({ const: id, title: m.name }));

  /** MCP elicitation: ask the person in front of the device for approval mid-call. */
  async function elicitApproval(extra, message) {
    if (!server.getClientCapabilities()?.elicitation) return null;
    const res = await extra.sendRequest({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: {
            approver: { type: 'string', title: 'Who is approving?', oneOf: adults() },
            passcode: { type: 'string', title: 'Household passcode', minLength: 4, maxLength: 12 },
          },
          required: ['approver', 'passcode'],
        },
      },
    }, ElicitResultSchema);
    return res.action === 'accept' ? res.content : null;
  }

  /** Ask the family safe-word question in the middle of the call (elicitation). */
  async function elicitSafeWord(extra, message, question) {
    if (!server.getClientCapabilities()?.elicitation) return null;
    const res = await extra.sendRequest({
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: question, minLength: 1 } }, required: ['answer'] },
      },
    }, ElicitResultSchema);
    return res.action === 'accept' ? res.content.answer : null;
  }

  async function approveInline(result, extra) {
    if (result.verdict !== 'confirm') return result;
    if (result.confirmation?.required_approver === 'safe_word') {
      for (let i = 0; i < SAFE_WORD_ATTEMPTS; i++) {
        const prompt = i === 0 ? result.say : `${result.approval.message} Please try once more.`;
        const answer = await elicitSafeWord(extra, prompt, result.confirmation.question);
        if (answer == null) {
          result.approval = { status: 'awaiting', message: 'No answer yet. Answer later with answer_challenge, or ask a guardian with request_guardian_approval.' };
          return result;
        }
        const c = await gate.answerChallenge(result.confirmation.id, answer);
        result.approval = { status: c.status, message: c.message };
        if (c.ok) {
          result.execution = unwrap(c.execution);
          result.say = 'Thanks, that matches. All done.';
          return result;
        }
        if (c.status === 'locked') {
          result.say = c.message;
          return result;
        }
      }
      return result;
    }
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const prompt = i === 0 ? result.say : `${result.approval.message} ${result.say}`;
      const answer = await elicitApproval(extra, prompt);
      if (!answer) {
        result.approval = { status: 'awaiting', message: 'No approval given yet. An adult can approve later with confirm_action.' };
        return result;
      }
      const c = await gate.confirm(result.confirmation.id, answer.approver, answer.passcode);
      result.approval = { status: c.status, approver: c.ok ? answer.approver : undefined, message: c.message };
      if (c.ok) {
        result.execution = unwrap(c.execution);
        result.say = `Approved by ${gate.policy.members[answer.approver].name}. All done.`;
        return result;
      }
      if (c.status === 'locked') {
        result.say = c.message;
        return result;
      }
    }
    return result;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...Object.entries(GATE_TOOLS).map(([name, t]) => ({
        name, title: t.title, description: t.description, inputSchema: toJsonSchema(t.input), annotations: t.annotations,
        ...(CARD_TOOLS.has(name) && { _meta: CARD_META }),
      })),
      ...gateway.listTools().map((t) => (t._meta['decision-gate/mode'] === 'gated' ? { ...t, _meta: { ...t._meta, ...CARD_META } } : t)),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: rawArgs = {} } = req.params;

    if (GATE_TOOLS[name]) {
      const parsed = GATE_TOOLS[name].input.safeParse(rawArgs);
      if (!parsed.success) return reply({ error: 'invalid_arguments', details: z.prettifyError(parsed.error) }, true);
      const a = parsed.data;
      switch (name) {
        case 'evaluate_action':
          return reply(await gate.evaluate(a.action, a.alexa_context));
        case 'confirm_action': {
          const c = await gate.confirm(a.confirmation_id, a.approver, a.passcode);
          return reply({ ...c, execution: unwrap(c.execution) }, !c.ok);
        }
        case 'get_policy':
          return reply(gate.getPolicy());
        case 'simulate_policy':
          return reply(gate.simulatePolicy(a.changes));
        case 'propose_policy_change':
          return reply(await gate.proposePolicy(a.request));
        case 'update_policy': {
          let { approver, passcode } = a;
          if (!passcode) {
            const answer = await elicitApproval(extra, `Changing house rules: ${describeChanges(a.changes)}. An adult needs to approve.`);
            if (answer) ({ approver, passcode } = answer);
          }
          const r = gate.updatePolicy(a.changes, approver, passcode);
          return reply(r, !r.ok);
        }
        case 'evaluate_checkout': {
          const r = await gate.checkout.evaluate(a, a.alexa_context);
          return reply(r.replayed || r.code ? r : await approveInline(r, extra));
        }
        case 'answer_challenge': {
          const c = await gate.answerChallenge(a.confirmation_id, a.answer);
          return reply({ ...c, execution: unwrap(c.execution) }, !c.ok);
        }
        case 'request_guardian_approval':
          return reply(gate.requestGuardian(a.confirmation_id, a.note));
        case 'guardian_decide': {
          const c = await gate.guardianDecide(a.confirmation_id, a.guardian, a.passcode, a.decision);
          return reply({ ...c, execution: unwrap(c.execution) }, !c.ok);
        }
        case 'set_safe_word_challenge': {
          let { approver, passcode } = a;
          if (!passcode) {
            const answer = await elicitApproval(extra, `Set the family safe word question to: "${a.question}". An adult needs to approve.`);
            if (answer) ({ approver, passcode } = answer);
          }
          const r = gate.setSafeWord(a.question, a.answer, approver, passcode, a.min_transfer);
          return reply(r, !r.ok);
        }
        case 'verify_addon': {
          const v = await gateway.verify(a.server);
          if (!v) return reply({ error: `Unknown add-on: ${a.server}` }, true);
          if (!v.ok) gate.recordIntegrity(v);
          return reply(v);
        }
        case 'pin_addon': {
          let { approver, passcode } = a;
          if (!passcode) {
            const answer = await elicitApproval(extra, `Approve the current tools of the ${a.server} add-on? Only do this if you trust the change.`);
            if (answer) ({ approver, passcode } = answer);
          }
          if (!gate.isAdultPasscode(approver, passcode)) return reply({ ok: false, message: 'Only an adult with a valid passcode can approve an add-on.' }, true);
          const r = await gateway.pin(a.server);
          if (!r) return reply({ error: `Unknown add-on: ${a.server}` }, true);
          gate.audit.append('addon_pinned', { server: a.server, approver, ok: r.ok, hash: r.pinned_hash }, gate.clock());
          return reply(r, !r.ok);
        }
        case 'scan_tool_text': {
          if (a.text) return reply({ findings: scanText(a.text) });
          const list = gateway.addons().filter((x) => !a.server || x.server === a.server);
          const out = {};
          for (const x of list) out[x.server] = (await gateway.verify(x.server)).findings;
          return reply({ findings: out });
        }
        case 'get_audit_log':
          return reply({
            chain: gate.audit.verify(),
            impact: gate.impactStats(),
            addons: gateway.addons(),
            entries: gate.audit.recent(a.limit, a.kind),
            pending: gate.pendingList(),
            notifications: gate.notifications.slice(0, 10),
          });
      }
    }

    const route = gateway.resolve(name);
    if (!route) return reply({ error: `Unknown tool: ${name}` }, true);
    const { alexa_context, ...args } = rawArgs;
    const forward = () => route.client.callTool({ name: route.toolName, arguments: args });

    // Add-on integrity: re-check the live manifest against the approved pin before anything is forwarded.
    const integrity = await gateway.verify(route.server);
    if (!integrity.ok) {
      gate.recordIntegrity(integrity);
      const detail = integrity.status === 'changed'
        ? `changed: ${[...integrity.changed, ...integrity.added.map((t) => `+${t}`), ...integrity.removed.map((t) => `-${t}`)].join(', ')}`
        : [...new Set(integrity.findings.map((f) => f.kind))].join(', ');
      const result = await gate.evaluate({
        type: 'other',
        server: route.server,
        tool: name,
        description: `${route.server} ${route.toolName.replace(/_/g, ' ')}`,
        flags: [integrity.status === 'changed' ? 'addon_changed' : 'hidden_instructions'],
        detail,
      }, alexa_context);
      return reply({ ...result, integrity: { status: integrity.status, pinned_hash: integrity.pinned_hash, current_hash: integrity.current_hash, changed: integrity.changed, findings: integrity.findings } });
    }

    if (route.mode === 'passthrough' || route.mode === 'quarantine') {
      // Read-only calls go straight through, but their output is filtered for prompt injection first.
      const { result, hits } = sanitizeResult(await forward());
      if (hits.length) gate.recordInjection({ server: route.server, tool: route.toolName, patterns: hits });
      return {
        ...result,
        _meta: { 'decision-gate/verdict': 'allow', 'decision-gate/mode': route.mode, ...(hits.length && { 'decision-gate/injection-removed': hits }) },
      };
    }

    let action;
    try {
      action = await gateway.toAction(route, args);
    } catch (err) {
      return reply({ error: String(err.message ?? err) }, true);
    }
    const result = await gate.evaluate(action, alexa_context, { execute: forward });
    if (result.execution) result.execution = unwrap(result.execution);
    return reply(await approveInline(result, extra));
  });

  return server;
}
