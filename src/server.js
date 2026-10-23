import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { DecisionGate } from './gate/gate.js';
import { createGateway } from './gateway/gateway.js';
import { buildMcpServer } from './mcp/server.js';
import { createVoice } from './gate/voice.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

/**
 * Spec (Streamable HTTP, security warning): servers MUST validate Origin and answer
 * an invalid one with 403. The SDK's Express helper checks Host only, so this adds
 * the Origin check. Same-origin pages (the simulator) and listed origins pass; requests
 * without an Origin header (non-browser clients such as Alexa+ or the Inspector CLI) pass.
 */
export function checkOrigin(allowed = []) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) return next();
    const self = `${req.protocol}://${req.headers.host}`;
    if (origin === self || allowed.includes(origin)) return next();
    return rpcError(res, 403, `Forbidden: origin ${origin} is not allowed`);
  };
}

/** Optional static bearer token (MCP_AUTH_TOKEN). Constant-time compare; 401 with a WWW-Authenticate challenge. */
export function checkBearer(token) {
  if (!token) return (_req, _res, next) => next();
  const expected = createHash('sha256').update(token).digest();
  return (req, res, next) => {
    const given = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (timingSafeEqual(createHash('sha256').update(given).digest(), expected)) return next();
    res.set('WWW-Authenticate', 'Bearer realm="decision-gate"');
    return rpcError(res, 401, 'Unauthorized: missing or invalid bearer token');
  };
}

const listEnv = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export async function createApp({
  gate = new DecisionGate({ dataDir: process.env.DATA_DIR ?? join(root, 'data') }),
  host = '127.0.0.1',
  demo = process.env.DEMO_MODE !== '0',
  authToken = process.env.MCP_AUTH_TOKEN,
  allowedOrigins = listEnv(process.env.ALLOWED_ORIGINS),
  voice = createVoice({ enabled: process.env.USE_POLLY !== '0' && hasAwsCredentials() }),
} = {}) {
  const gateway = await createGateway({ trusted: () => gate.policy.trusted_servers });
  const app = createMcpExpressApp({ host });
  const transports = new Map();

  app.use(express.static(join(root, 'public')));
  app.get('/healthz', (_req, res) => res.json({ ok: true, sessions: transports.size, chain: gate.audit.verify() }));
  app.use('/mcp', checkOrigin(allowedOrigins), checkBearer(authToken));

  // Amazon Polly: the simulator posts each spoken line here and plays the MP3.
  app.post('/tts', checkOrigin(allowedOrigins), async (req, res) => {
    const text = String(req.body?.text ?? '').slice(0, 600);
    if (!text.trim()) return res.status(400).json({ error: 'text required' });
    try {
      const audio = await voice.synthesize(text);
      res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'X-Voice': voice.status().voice }).send(audio);
    } catch (err) {
      res.status(503).json({ error: err.name, message: err.message });
    }
  });
  app.get('/tts/status', (_req, res) => res.json(voice.status()));

  // Streamable HTTP MCP endpoint (one transport + server per session).
  app.post('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      // Spec: a session id we don't know (expired, or from before a restart) gets 404 so the client re-initializes.
      if (sid) return rpcError(res, 404, 'Session not found');
      if (!isInitializeRequest(req.body)) return rpcError(res, 400, 'Bad Request: missing MCP-Session-Id or initialize');
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
      await buildMcpServer(gate, gateway).connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const bySession = async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    if (!sid) return rpcError(res, 400, 'Bad Request: missing MCP-Session-Id');
    const transport = transports.get(sid);
    if (!transport) return rpcError(res, 404, 'Session not found');
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', bySession);
  app.delete('/mcp', bySession);

  if (demo) {
    // Demo only: make the DealsBot add-on silently rewrite a tool description after approval.
    app.post('/demo/rug-pull', (_req, res) => {
      const d = gateway.downstream.dealsbot;
      if (!d?.server.rugPull) return res.status(404).json({ ok: false });
      d.server.rugPull();
      res.json({ ok: true, server: 'dealsbot', tool: 'search_deals' });
    });
    // Demo only: rewrite an old audit entry the way an attacker with disk access would.
    app.post('/demo/tamper', (_req, res) => {
      const target = gate.audit.entries.find((e) => e.kind === 'decision' && e.data.verdict !== 'allow');
      if (!target) return res.status(404).json({ ok: false, message: 'Nothing to tamper with yet' });
      gate.audit.tamper(target.seq, (d) => { d.verdict = 'allow'; });
      res.json({ ok: true, tampered_seq: target.seq, chain: gate.audit.verify() });
    });
  }

  return { app, gate, gateway, transports, voice };
}

/** True if the AWS SDK's default credential chain has something to find (env keys, a profile, or ~/.aws files). */
export function hasAwsCredentials(env = process.env) {
  if (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
  const home = env.USERPROFILE || env.HOME || '';
  return existsSync(join(home, '.aws', 'credentials')) || existsSync(join(home, '.aws', 'config'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // `--bedrock` works the same in PowerShell, cmd and bash (no inline VAR=value needed).
  if (process.argv.includes('--bedrock')) process.env.USE_BEDROCK = '1';
  if (process.env.USE_BEDROCK === '1' && !hasAwsCredentials()) {
    console.warn('Bedrock is on but no AWS credentials were found. Add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to .env (see .env.example), then run: npm run bedrock:check');
  }
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1';
  const { app } = await createApp({ host });
  app.listen(port, host, () => {
    console.log(`Decision Gate MCP server  http://${host}:${port}/mcp`);
    const token = process.env.MCP_AUTH_TOKEN;
    console.log(`Alexa+ simulator          http://${host}:${port}/${token ? `#token=${encodeURIComponent(token)}` : ''}`);
    console.log(`Auth                      ${token ? 'bearer token required (MCP_AUTH_TOKEN)' : 'off (set MCP_AUTH_TOKEN to require a bearer token)'}`);
    console.log(`Amazon Bedrock            ${process.env.USE_BEDROCK === '1' ? `on (${process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0'}, ${process.env.AWS_REGION || 'us-east-1'})` : 'off (template lines and phrase rules); run npm run dev:bedrock to turn it on'}`);
  });
}
