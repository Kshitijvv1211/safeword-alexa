// A minimal, dependency-free MCP client speaking Streamable HTTP (spec 2025-11-25),
// written out by hand so every JSON-RPC message is visible in the simulator.
// It handles JSON and SSE responses, and answers server-initiated
// elicitation/create requests that arrive mid-call on the SSE stream.

export const PROTOCOL_VERSION = '2025-11-25';

export class McpHttpClient {
  constructor(url, { token = null, onTraffic = () => {}, onElicit = async () => ({ action: 'decline' }) } = {}) {
    this.url = url;
    this.token = token;
    this.onTraffic = onTraffic;
    this.onElicit = onElicit;
    this.sessionId = null;
    this.nextId = 1;
  }

  headers() {
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) {
      h['mcp-session-id'] = this.sessionId;
      h['mcp-protocol-version'] = PROTOCOL_VERSION;
    }
    return h;
  }

  async post(message, tag) {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(message) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return res;
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        elicitation: { form: {} },
        // This simulator is also an MCP Apps host, so it can render the gate's decision card.
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
      clientInfo: { name: 'alexa-plus-simulator', title: 'Alexa+ simulator', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
    return result;
  }

  async notify(method, params, tag) {
    const msg = { jsonrpc: '2.0', method, ...(params && { params }) };
    this.onTraffic({ dir: 'out', msg, tag });
    await this.post(msg, tag);
  }

  /** Spec: tell the server we're done with the session. keepalive lets it run during page unload. */
  close() {
    if (!this.sessionId) return;
    fetch(this.url, { method: 'DELETE', headers: this.headers(), keepalive: true }).catch(() => {});
    this.sessionId = null;
  }

  async request(method, params = {}, tag, retried = false) {
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.onTraffic({ dir: 'out', msg, tag });
    const res = await this.post(msg, tag);
    if (res.status === 404 && this.sessionId && method !== 'initialize' && !retried) {
      // Spec: 404 on a session id means the session is gone; start a new one and retry once.
      this.onTraffic({ dir: 'in', msg: { note: 'HTTP 404: session expired, re-initializing' }, tag });
      this.sessionId = null;
      await this.initialize();
      return this.request(method, params, tag, true);
    }
    if (res.status === 401) throw new Error('Unauthorized: open the simulator with #token=<MCP_AUTH_TOKEN>');
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      return this.#settle(await res.json(), tag);
    }
    if (!type.includes('text/event-stream')) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Stream ended without a response');
      buffer += value;
      let cut;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const incoming = JSON.parse(data);
        if (incoming.id === id && ('result' in incoming || 'error' in incoming)) {
          reader.cancel().catch(() => {});
          return this.#settle(incoming, tag);
        }
        await this.#handleServerMessage(incoming, tag);
      }
    }
  }

  #settle(response, tag) {
    this.onTraffic({ dir: 'in', msg: response, tag });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  }

  async #handleServerMessage(msg, tag) {
    this.onTraffic({ dir: 'in', msg, tag });
    if (msg.method === 'elicitation/create' && msg.id !== undefined) {
      const result = await this.onElicit(msg.params);
      const reply = { jsonrpc: '2.0', id: msg.id, result };
      this.onTraffic({ dir: 'out', msg: reply, tag });
      await this.post(reply, tag);
    }
  }

  listTools(tag) {
    return this.request('tools/list', {}, tag);
  }

  callToolRaw(name, args, tag) {
    return this.request('tools/call', { name, arguments: args }, tag);
  }

  async callTool(name, args, tag) {
    const result = await this.callToolRaw(name, args, tag);
    return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? 'null');
  }
}
