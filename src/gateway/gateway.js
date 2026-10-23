import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BRANDS } from '../downstream/brands.js';
import { SIDE_EFFECT_WORDS } from './sanitize.js';
import { pinManifest, scanTools, verifyManifest } from './manifest-guard.js';

// The gateway is a real MCP client to each brand server. It re-exposes their
// tools to Alexa+ under "<server>__<tool>" and decides, per tool, whether a
// call can pass straight through or must go through the Decision Gate first.

export const SEP = '__';

const textOf = (result) => JSON.parse(result.content?.[0]?.text ?? '{}');

/** Turn a brand tool call into the action the gate understands. */
export const ADAPTERS = {
  freshcart: {
    place_order: async (args, client) => {
      const q = textOf(await client.callTool({ name: 'quote_cart', arguments: { items: args.items } }));
      return {
        type: 'purchase',
        amount: q.total,
        currency: q.currency,
        merchant: q.seller,
        category: q.category,
        item: q.summary,
        quantity: q.quantity,
        description: `Order ${q.summary} from ${q.seller}`,
      };
    },
  },
  lockwise: {
    unlock_door: async (args) => ({ type: 'unlock', door: args.door.replace('_', ' '), description: `Unlock the ${args.door.replace('_', ' ')}` }),
    lock_door: async (args) => ({ type: 'secure', door: args.door, description: `Lock the ${args.door.replace('_', ' ')}` }),
  },
  quickpay: {
    send_money: async (args) => ({ type: 'transfer', amount: args.amount, payee: args.payee, description: `Send $${args.amount} to ${args.payee}` }),
  },
};

export const ALEXA_CONTEXT_SCHEMA = {
  type: 'object',
  description: 'Household signals Alexa+ already has: who is speaking (voice ID), what they said, local time, and whether anyone is home.',
  properties: {
    speaker: {
      type: 'object',
      properties: { id: { type: 'string' }, role: { type: 'string', enum: ['adult', 'child', 'elder', 'unknown'] } },
    },
    utterance: { type: 'string' },
    local_time: { type: 'string', description: 'HH:MM, household local time' },
    home_occupied: { type: 'boolean' },
  },
};

export async function createGateway({ brands = BRANDS, trusted = () => Object.keys(brands) } = {}) {
  const downstream = {};
  for (const [name, factory] of Object.entries(brands)) {
    const server = factory();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'decision-gate', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    // Trust on first use: the manifest seen at connect time is pinned. Alexa+ is only
    // ever shown this pinned version; any later change must be re-approved by an adult.
    downstream[name] = {
      server,
      client,
      tools: Object.fromEntries(tools.map((t) => [t.name, t])),
      pin: { ...pinManifest(tools), pinned_at: new Date().toISOString() },
      findings: scanTools(tools),
      status: 'ok',
    };
    if (downstream[name].findings.length) downstream[name].status = 'poisoned';
  }

  /** Re-read a server's live manifest and compare it with the pin. Runs before every forwarded call. */
  async function verify(name) {
    const d = downstream[name];
    if (!d) return null;
    const { tools } = await d.client.listTools();
    const v = verifyManifest(d.pin, tools);
    const findings = scanTools(tools);
    d.status = !v.ok ? 'changed' : findings.length ? 'poisoned' : 'ok';
    d.findings = findings;
    return { server: name, status: d.status, ok: d.status === 'ok', pinned_hash: d.pin.hash, current_hash: v.hash, added: v.added, removed: v.removed, changed: v.changed, findings };
  }

  /** Approve the current manifest (after an adult reviewed it). Refused if it contains hidden instructions. */
  async function pin(name) {
    const d = downstream[name];
    if (!d) return null;
    const { tools } = await d.client.listTools();
    const findings = scanTools(tools);
    if (findings.length) return { ok: false, server: name, findings, message: 'This manifest contains hidden instructions and cannot be approved.' };
    d.pin = { ...pinManifest(tools), pinned_at: new Date().toISOString() };
    d.tools = Object.fromEntries(tools.map((t) => [t.name, t]));
    d.findings = [];
    d.status = 'ok';
    return { ok: true, server: name, pinned_hash: d.pin.hash, tools: tools.length };
  }

  function addons() {
    return Object.entries(downstream).map(([name, d]) => ({
      server: name,
      trusted: trusted().includes(name),
      status: d.status,
      pinned_hash: d.pin.hash,
      pinned_at: d.pin.pinned_at,
      tools: Object.keys(d.pin.tools),
      findings: d.findings,
    }));
  }

  /**
   * How a tool is treated. Annotations are only hints (per the MCP spec), so they
   * can only relax scrutiny for servers the household has marked trusted; an
   * untrusted server's "readOnlyHint" is ignored and its calls are gated.
   */
  function classify(server, toolName) {
    const tool = downstream[server]?.tools[toolName];
    if (!tool) return null;
    if (ADAPTERS[server]?.[toolName]) return { mode: 'gated', tool };
    const isTrusted = trusted().includes(server);
    const claimsReadOnly = tool.annotations?.readOnlyHint === true;
    if (claimsReadOnly && isTrusted) return { mode: 'passthrough', tool };
    if (claimsReadOnly) {
      // Untrusted server: check the hint against what the tool says it does.
      if (SIDE_EFFECT_WORDS.test(`${toolName.replace(/_/g, ' ')} ${tool.description ?? ''}`)) {
        return { mode: 'gated', tool, flags: ['untrusted_server', 'annotation_mismatch'] };
      }
      return { mode: 'quarantine', tool };
    }
    return { mode: 'gated', tool, flags: isTrusted ? [] : ['untrusted_server'] };
  }

  function listTools() {
    const out = [];
    for (const [server, { tools }] of Object.entries(downstream)) {
      for (const t of Object.values(tools)) {
        const c = classify(server, t.name);
        out.push({
          name: `${server}${SEP}${t.name}`,
          title: `${server}: ${t.name.replace(/_/g, ' ')}`,
          description: `${{ gated: '[Checked by Decision Gate] ', quarantine: '[Untrusted server: output filtered by Decision Gate] ' }[c.mode] ?? ''}${t.description ?? ''}`,
          inputSchema: {
            ...t.inputSchema,
            properties: { ...(t.inputSchema.properties ?? {}), alexa_context: ALEXA_CONTEXT_SCHEMA },
          },
          annotations: t.annotations,
          _meta: { 'decision-gate/mode': c.mode, 'decision-gate/upstream': server },
        });
      }
    }
    return out;
  }

  function resolve(name) {
    const i = name.indexOf(SEP);
    if (i < 0) return null;
    const server = name.slice(0, i), toolName = name.slice(i + SEP.length);
    const c = classify(server, toolName);
    return c && { server, toolName, ...c, client: downstream[server].client };
  }

  async function toAction(route, args) {
    const adapter = ADAPTERS[route.server]?.[route.toolName];
    if (adapter) return { ...(await adapter(args, route.client)), server: route.server, tool: route.toolName };
    return {
      type: 'other',
      server: route.server,
      tool: `${route.server}${SEP}${route.toolName}`,
      description: `${route.server} ${route.toolName.replace(/_/g, ' ')}`,
      flags: route.flags ?? [],
    };
  }

  async function close() {
    await Promise.all(Object.values(downstream).map((d) => d.client.close()));
  }

  return { downstream, listTools, resolve, toAction, verify, pin, addons, close };
}
