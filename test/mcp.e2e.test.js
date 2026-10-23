import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createApp } from '../src/server.js';
import { DecisionGate } from '../src/gate/gate.js';

// End to end over Streamable HTTP: the same initialize, tools/list, tools/call
// and elicitation/create traffic Alexa+ would exchange with the server.

let httpServer, url, gateway;
let elicitAnswer = { approver: 'sam', passcode: '4321' };
const elicitations = [];

before(async () => {
  const gate = new DecisionGate({ explain: async (d) => ({ text: d.say, source: 'template' }) });
  const built = await createApp({ gate, demo: false });
  gateway = built.gateway;
  await new Promise((resolve) => { httpServer = built.app.listen(0, '127.0.0.1', resolve); });
  url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
});

after(async () => {
  await gateway.close();
  httpServer.closeAllConnections();
  await new Promise((r) => httpServer.close(r));
});

async function connect({ elicitation = true } = {}) {
  const client = new Client({ name: 'alexa-plus-test', version: '1.0.0' }, { capabilities: elicitation ? { elicitation: { form: {} } } : {} });
  if (elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      elicitations.push(req.params);
      return elicitAnswer ? { action: 'accept', content: elicitAnswer } : { action: 'decline' };
    });
  }
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  return { client, transport };
}

const call = async (client, name, args) => (await client.callTool({ name, arguments: args })).structuredContent;
const alex = (t) => ({ speaker: { id: 'alex', role: 'adult' }, local_time: t, home_occupied: true });

test('negotiates the 2025-11-25 protocol and lists gate + proxied tools', async () => {
  const { client, transport } = await connect();
  assert.equal(transport.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['evaluate_action', 'confirm_action', 'simulate_policy', 'freshcart__place_order', 'lockwise__unlock_door', 'quickpay__send_money']) {
    assert.ok(names.includes(n), n);
  }
  const place = tools.find((t) => t.name === 'freshcart__place_order');
  assert.equal(place._meta['decision-gate/mode'], 'gated');
  assert.ok(place.inputSchema.properties.alexa_context);
  assert.equal(tools.find((t) => t.name === 'freshcart__search_products')._meta['decision-gate/mode'], 'passthrough');
  await client.close();
});

test('usual groceries pass the gate and reach FreshCart', async () => {
  const { client } = await connect();
  const usual = await call(client, 'freshcart__get_usual_order', {});
  const r = await call(client, 'freshcart__place_order', { items: usual.items, alexa_context: alex('18:00') });
  assert.equal(r.verdict, 'allow');
  assert.equal(r.execution.status, 'placed');
  await client.close();
});

test('late-night monitor is approved inline through MCP elicitation', async () => {
  const { client } = await connect();
  elicitations.length = 0;
  elicitAnswer = { approver: 'sam', passcode: '4321' };
  const r = await call(client, 'freshcart__place_order', { items: [{ sku: 'monitor-27-4k', qty: 1 }], alexa_context: alex('23:05') });
  assert.equal(r.verdict, 'confirm');
  assert.equal(elicitations.length, 1);
  assert.equal(elicitations[0].requestedSchema.required.join(), 'approver,passcode');
  assert.equal(r.approval.status, 'approved');
  assert.equal(r.execution.status, 'placed');
  await client.close();
});

test('without elicitation support the action waits for confirm_action', async () => {
  const { client } = await connect({ elicitation: false });
  const r = await call(client, 'freshcart__place_order', { items: [{ sku: 'monitor-27-4k', qty: 1 }], alexa_context: alex('23:10') });
  assert.equal(r.verdict, 'confirm');
  assert.equal(r.execution, undefined);
  const c = await call(client, 'confirm_action', { confirmation_id: r.confirmation.id, approver: 'sam', passcode: '4321' });
  assert.equal(c.ok, true);
  assert.equal(c.execution.status, 'placed');
  await client.close();
});

test('blocked actions never reach the brand server', async () => {
  const { client } = await connect();
  const r = await call(client, 'lockwise__unlock_door', { door: 'front_door', alexa_context: { speaker: { role: 'unknown' }, local_time: '02:00', home_occupied: false } });
  assert.equal(r.verdict, 'block');
  assert.equal(r.execution, undefined);
  const status = await call(client, 'lockwise__get_lock_status', {});
  assert.equal(status.doors.front_door, 'locked');
  await client.close();
});

test('rogue server: injected text never reaches Alexa+, mislabelled charge is blocked', async () => {
  const { client } = await connect();
  const raw = await client.callTool({ name: 'dealsbot__search_deals', arguments: {} });
  assert.ok(raw._meta['decision-gate/injection-removed'].length > 0);
  const text = JSON.stringify(raw);
  assert.doesNotMatch(text, /ignore previous instructions/i);
  assert.doesNotMatch(text, /freshcart__place_order/);
  assert.match(text, /Wireless earbuds/);
  const claim = await call(client, 'dealsbot__claim_deal', { deal_id: 'deal-1', alexa_context: alex('19:00') });
  assert.equal(claim.verdict, 'block');
  assert.equal(claim.execution, undefined);
  const log = await call(client, 'get_audit_log', { limit: 50, kind: 'injection_blocked' });
  assert.equal(log.entries[0].data.server, 'dealsbot');
  assert.ok(log.impact.injections_removed >= 1);
  await client.close();
});

test('audit log over MCP reports an intact chain', async () => {
  const { client } = await connect();
  const log = await call(client, 'get_audit_log', { limit: 5 });
  assert.equal(log.chain.intact, true);
  assert.ok(log.entries.length > 0);
  await client.close();
});
