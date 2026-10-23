import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/server.js';
import { DecisionGate } from '../src/gate/gate.js';
import { DECISION_CARD_URI, MCP_APP_MIME } from '../src/mcp/server.js';

// Streamable HTTP security rules (Origin 403, session 404, auth) and the MCP Apps resource.

const TOKEN = 'test-token-123';
const servers = [];

async function start(opts) {
  const gate = new DecisionGate({ explain: async (d) => ({ text: d.say, source: 'template' }) });
  const built = await createApp({ gate, demo: false, ...opts });
  const http = await new Promise((resolve) => { const s = built.app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push({ http, gateway: built.gateway });
  return `http://127.0.0.1:${http.address().port}/mcp`;
}

let open, locked;
before(async () => {
  open = await start({ allowedOrigins: ['https://alexa.example'] });
  locked = await start({ authToken: TOKEN });
});

after(async () => {
  for (const { http, gateway } of servers) {
    await gateway.close();
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  }
});

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const headers = (extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
const post = (url, body, extra) => fetch(url, { method: 'POST', headers: headers(extra), body: JSON.stringify(body) });

test('a foreign Origin is rejected with 403', async () => {
  const res = await post(open, INIT, { origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, -32000);
});

test('same-origin, allow-listed, and Origin-less requests are accepted', async () => {
  const self = new URL(open).origin;
  for (const origin of [self, 'https://alexa.example', undefined]) {
    const res = await post(open, INIT, origin ? { origin } : {});
    assert.equal(res.status, 200, String(origin));
    await res.body?.cancel();
  }
});

test('an unknown session id gets 404 on POST, GET and DELETE', async () => {
  const sid = { 'mcp-session-id': 'no-such-session', 'mcp-protocol-version': '2025-11-25' };
  assert.equal((await post(open, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sid)).status, 404);
  assert.equal((await fetch(open, { headers: { accept: 'text/event-stream', ...sid } })).status, 404);
  assert.equal((await fetch(open, { method: 'DELETE', headers: sid })).status, 404);
});

test('a non-initialize request without a session id gets 400', async () => {
  assert.equal((await post(open, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 400);
});

test('DELETE ends a session; later requests on it get 404', async () => {
  const res = await post(open, INIT);
  const sid = res.headers.get('mcp-session-id');
  await res.body?.cancel();
  const h = { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' };
  assert.equal((await fetch(open, { method: 'DELETE', headers: h })).status, 200);
  assert.equal((await post(open, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, h)).status, 404);
});

test('with MCP_AUTH_TOKEN set, a missing or wrong bearer token gets 401', async () => {
  const none = await post(locked, INIT);
  assert.equal(none.status, 401);
  assert.match(none.headers.get('www-authenticate'), /^Bearer/);
  assert.equal((await post(locked, INIT, { authorization: 'Bearer wrong' })).status, 401);
});

test('the SDK client connects with the right bearer token', async () => {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(locked), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  assert.ok((await client.listTools()).tools.length > 0);
  await client.close();
});

test('MCP Apps: gated tools link the decision card and the resource is served', async () => {
  const client = new Client({ name: 'apps-host', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME] } } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(open)));
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.freshcart__place_order._meta.ui.resourceUri, DECISION_CARD_URI);
  assert.equal(byName.evaluate_action._meta.ui.resourceUri, DECISION_CARD_URI);
  assert.equal(byName.freshcart__search_products._meta.ui, undefined, 'passthrough tools have no card');

  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [[DECISION_CARD_URI, MCP_APP_MIME]]);
  const { contents } = await client.readResource({ uri: DECISION_CARD_URI });
  assert.equal(contents[0].mimeType, MCP_APP_MIME);
  assert.match(contents[0].text, /ui\/initialize/);
  assert.match(contents[0].text, /ui\/notifications\/tool-result/);
  await client.close();
});

test('Agent Skill has valid frontmatter', () => {
  const md = readFileSync(new URL('../skills/decision-gate/SKILL.md', import.meta.url), 'utf8');
  const front = /^---\n([\s\S]*?)\n---/.exec(md.replace(/\r\n/g, '\n'))?.[1] ?? '';
  assert.match(front, /^name: decision-gate$/m);
  const desc = /^description: (.+)$/m.exec(front)?.[1] ?? '';
  assert.ok(desc.length > 20 && desc.length <= 1024);
});
