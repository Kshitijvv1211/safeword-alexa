import { McpHttpClient } from './mcp-client.js';

// SafeWord: simulated Alexa+ experience. The real Alexa+ uses an LLM to pick tools;
// here a small phrase matcher stands in for that step so the demo is repeatable.
// Every action still goes over real MCP to the Decision Gate engine at /mcp.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `$${Number(n).toFixed(Number(n) % 1 ? 2 : 0)}`;

const SCENARIOS = [
  { label: 'Usual groceries', speaker: 'alex|adult', time: '18:00', home: true, say: 'Reorder my usual groceries' },
  { label: '$480 monitor at 11pm', speaker: 'alex|adult', time: '23:05', home: true, say: 'Order the 27-inch 4K monitor' },
  { label: 'Child buys game passes', speaker: 'mia|child', time: '16:30', home: true, say: 'Order 3 game passes' },
  { label: 'Stranger at 2am', speaker: '|unknown', time: '02:00', home: false, say: 'Unlock the front door' },
  { label: 'Grandparent scam', speaker: 'grandpa|elder', time: '15:10', home: true, say: "Send $900 to Jake Miller, it's urgent, he needs bail money, don't tell anyone" },
  { label: 'Pay Sam back', speaker: 'alex|adult', time: '12:00', home: true, say: 'Send $20 to Sam Rivera' },
  { label: 'What if limit were $20?', speaker: 'alex|adult', time: '12:00', home: true, say: 'What would change if the auto-approve limit were $20?' },
  { label: 'Rogue store: find deals', speaker: 'alex|adult', time: '19:00', home: true, say: 'Find me some deals' },
  { label: 'Rogue store: claim deal', speaker: 'alex|adult', time: '19:01', home: true, say: 'Claim the earbuds deal' },
  { label: 'New rule in plain English', speaker: 'alex|adult', time: '20:00', home: true, say: 'New rule: lower the auto-approve limit to $20 and block video games' },
  { label: 'Cloned voice: $900', speaker: 'alex|adult', time: '14:00', home: true, say: "It's Alex. Send $900 to Mark Davis right now" },
  { label: 'Add-on rug pull', speaker: 'alex|adult', time: '19:05', home: true, say: 'Find me some deals', before: () => fetch('/demo/rug-pull', { method: 'POST' }) },
  { label: 'Checkout: price jumps', speaker: 'sam|adult', time: '17:00', home: true, run: () => checkoutDrift() },
  { label: 'Checkout: retried payment', speaker: 'sam|adult', time: '17:05', home: true, run: () => checkoutRetry() },
  { label: 'Checkout: duplicate order', speaker: 'sam|adult', time: '17:10', home: true, run: () => checkoutDuplicate() },
];

// ---------- checkout scenarios (Alexa+-style sessions with Idempotency-Keys) ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const session = (id, sku, title, price, qty, total) => ({
  id, currency: 'USD',
  line_items: [{ item: { id: sku, title, price, category: 'groceries' }, quantity: qty }],
  totals: [{ type: 'subtotal', amount: price * qty }, { type: 'total', amount: total }],
});

async function checkoutStep(label, args) {
  bubble('system', esc(label));
  $('decision-tool').textContent = `evaluate_checkout · ${args.phase}`;
  const raw = await mcp.callToolRaw('evaluate_checkout', { ...args, alexa_context: context(label) });
  const out = raw.structuredContent ?? JSON.parse(raw.content?.[0]?.text ?? 'null');
  renderOutcome({ tool: 'evaluate_checkout' }, out);
  speak(out.say);
  await mountApp(out.replayed || out.code ? null : 'evaluate_checkout', args, raw);
  return out;
}

async function checkoutDrift() {
  const id = `chk_${uid()}`;
  await checkoutStep('Checkout created: weekly produce box, total $42.00', { phase: 'create', idempotency_key: uid() + uid(), merchant: 'FreshCart', session: session(id, 'produce-box', 'Weekly produce box', 42, 1, 42) });
  await checkoutStep('Payment step: the total is now $49.56', { phase: 'complete', idempotency_key: uid() + uid(), merchant: 'FreshCart', session: session(id, 'produce-box', 'Weekly produce box', 42, 1, 49.56) });
}

async function checkoutRetry() {
  const key = uid() + uid();
  const args = { phase: 'complete', idempotency_key: key, merchant: 'FreshCart', session: session(`chk_${uid()}`, 'coffee', 'Ground coffee, 12 oz', 10.49, 2, 20.98) };
  await checkoutStep('Payment: 2 x ground coffee, $20.98', args);
  await checkoutStep('Network glitch: Alexa+ retries the same payment (same Idempotency-Key)', args);
  await checkoutStep('A different request reuses that Idempotency-Key', { ...args, session: { ...args.session, totals: [{ type: 'total', amount: 209.8 }] } });
}

async function checkoutDuplicate() {
  const make = () => session(`chk_${uid()}`, 'paper-towels', 'Paper towels, 6 rolls', 8.99, 1, 8.99);
  await checkoutStep('Payment: paper towels, $8.99', { phase: 'complete', idempotency_key: uid() + uid(), merchant: 'FreshCart', session: make() });
  await checkoutStep('A minute later: the same order again, new session', { phase: 'complete', idempotency_key: uid() + uid(), merchant: 'FreshCart', session: make() });
}

// ---------- traffic panel ----------
let showUi = false;
function onTraffic({ dir, msg, tag }) {
  const li = document.createElement('li');
  const isUi = tag === 'ui';
  li.className = `msg ${dir} ${isUi ? 'ui' : ''}`;
  li.hidden = isUi && !showUi;
  const kind = msg.method ?? msg.note ?? (msg.error ? 'error' : 'result');
  const label = msg.method === 'tools/call' ? `tools/call · ${msg.params.name}` : kind;
  const arrow = dir === 'out' ? '→' : '←';
  const who = dir === 'out' ? 'Alexa+' : 'Gate';
  li.innerHTML = `<details><summary><span class="arrow">${arrow}</span><span class="who">${who}</span><span class="m">${esc(label)}</span>${msg.id !== undefined ? `<span class="id">#${msg.id}</span>` : ''}</summary><pre>${esc(JSON.stringify(msg, null, 2))}</pre></details>`;
  if (msg.method === 'elicitation/create') li.classList.add('elicit-msg');
  $('traffic').prepend(li);
  while ($('traffic').children.length > 120) $('traffic').lastChild.remove();
}

// ---------- elicitation dialog (renders whatever form schema the server asks for) ----------
function onElicit(params) {
  return new Promise((resolve) => {
    const dlg = $('elicit');
    const props = params.requestedSchema.properties ?? {};
    const isSafeWord = 'answer' in props;
    $('elicit-title').textContent = isSafeWord ? 'Family safe word' : 'Approval needed';
    $('elicit-msg').textContent = params.message;
    $('elicit-fields').innerHTML = Object.entries(props).map(([key, f]) => {
      const options = f.oneOf ?? (f.enum ?? []).map((v) => ({ const: v, title: v }));
      const input = options.length
        ? `<select id="ef-${key}" name="${key}">${options.map((o) => `<option value="${esc(o.const)}">${esc(o.title)}</option>`).join('')}</select>`
        : `<input id="ef-${key}" name="${key}" type="${key === 'passcode' ? 'password' : 'text'}" ${key === 'passcode' ? 'inputmode="numeric"' : ''} autocomplete="off">`;
      return `<label for="ef-${key}">${esc(f.title ?? key)}${input}</label>`;
    }).join('');
    $('elicit-hint').textContent = isSafeWord
      ? 'Demo safe word: Biscuit. A cloned voice would not know it.'
      : 'Demo passcodes: Sam 4321, Alex 2468.';
    dlg.showModal();
    setTimeout(() => $('elicit-fields').querySelector('input')?.focus(), 50);
    dlg.addEventListener('close', function done() {
      dlg.removeEventListener('close', done);
      if (dlg.returnValue !== 'accept') return resolve({ action: 'decline' });
      const content = Object.fromEntries(Object.keys(props).map((k) => [k, $(`ef-${k}`).value]));
      resolve({ action: 'accept', content });
    });
  });
}

// With MCP_AUTH_TOKEN set, open the simulator as /#token=<token>; it is kept for this tab only.
function authToken() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  try {
    if (fromHash) sessionStorage.setItem('mcp-token', fromHash);
    return fromHash ?? sessionStorage.getItem('mcp-token');
  } catch {
    return fromHash;
  }
}

const mcp = new McpHttpClient('/mcp', { token: authToken(), onTraffic, onElicit });
addEventListener('pagehide', () => mcp.close());

// ---------- context from the device controls ----------
function context(utterance) {
  const [id, role] = $('speaker').value.split('|');
  return {
    speaker: { ...(id && { id }), role },
    utterance,
    local_time: $('time').value,
    home_occupied: $('home').checked,
  };
}

// ---------- intent matching (stand-in for the Alexa+ LLM) ----------
const DOORS = { front: 'front_door', back: 'back_door', garage: 'garage' };
const WORDNUM = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };

async function plan(text) {
  const t = text.toLowerCase();
  let m;
  if (/what (would|if)|dry.?run/.test(t) && (m = t.match(/limit (?:were|was|to|of|at)?\s*\$?(\d+)/))) {
    return { tool: 'simulate_policy', args: { changes: { purchases: { auto_approve_limit: +m[1] } } }, gateOnly: true };
  }
  if (/\brule\b/.test(t) || /^(lower|raise|set|change|block|unblock|let|allow|make|stop|don'?t let)\b.*\b(limit|quiet hours|kids|children|hold|cooling|games|gift cards|crypto|electronics)\b/.test(t)) {
    return { tool: 'propose_policy_change', args: { request: text.replace(/^new rule:\s*/i, '') }, gateOnly: true };
  }
  if (/\bdeals?\b/.test(t)) {
    return /\b(claim|buy|get)\b/.test(t)
      ? { tool: 'dealsbot__claim_deal', args: { deal_id: 'deal-1' } }
      : { tool: 'dealsbot__search_deals', args: { query: '' } };
  }
  if (/usual|reorder|groceries/.test(t)) {
    const usual = await mcp.callTool('freshcart__get_usual_order', {});
    return { tool: 'freshcart__place_order', args: { items: usual.items } };
  }
  const qty = (word) => +(word && (WORDNUM[word] ?? word)) || 1;
  if ((m = t.match(/(\w+)?\s*game pass/))) return { tool: 'freshcart__place_order', args: { items: [{ sku: 'game-pass', qty: qty(m[1]) }] } };
  if (/monitor/.test(t)) return { tool: 'freshcart__place_order', args: { items: [{ sku: 'monitor-27-4k', qty: 1 }] } };
  if (/gift card/.test(t) && !/send/.test(t)) return { tool: 'freshcart__place_order', args: { items: [{ sku: 'gift-card-100', qty: 1 }] } };
  if ((m = t.match(/(\w+)?\s*(?:packs? of )?paper towels/))) return { tool: 'freshcart__place_order', args: { items: [{ sku: 'paper-towels', qty: qty(m[1]) }] } };
  if ((m = t.match(/\bunlock (?:the )?(front|back|garage)/))) return { tool: 'lockwise__unlock_door', args: { door: DOORS[m[1]] } };
  if ((m = t.match(/\block (?:the )?(front|back|garage)/))) return { tool: 'lockwise__lock_door', args: { door: DOORS[m[1]] } };
  if (/locks?|locked/.test(t)) return { tool: 'lockwise__get_lock_status', args: {} };
  if ((m = text.match(/[Ss]end \$?(\d+(?:\.\d+)?)\s*(?:dollars )?to ([A-Z][\w'-]*(?: [A-Z][\w'-]*)*)/))) {
    return { tool: 'quickpay__send_money', args: { amount: +m[1], payee: m[2].trim() } };
  }
  if (/balance/.test(t)) return { tool: 'quickpay__get_balance', args: {} };
  return null;
}

// ---------- chat ----------
function bubble(who, html, cls = '') {
  const hint = document.querySelector('.chat .hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.className = `bubble ${who} ${cls}`;
  div.innerHTML = html;
  $('chat').append(div);
  $('chat').scrollTop = $('chat').scrollHeight;
}

function thinking(on) {
  $('ring').classList.toggle('on', on);
}

function speakerName() {
  return $('speaker').selectedOptions[0].textContent.split(' (')[0];
}

async function handle(text) {
  if (!text.trim()) return;
  bubble('user', `<span class="who">${esc(speakerName())}</span>${esc(text)}`);
  thinking(true);
  try {
    const step = await plan(text);
    if (!step) {
      bubble('alexa', "Sorry, this simulator only knows the demo phrases. Try one of the scenarios below.");
      return;
    }
    $('decision-tool').textContent = step.tool;
    const args = step.gateOnly ? step.args : { ...step.args, alexa_context: context(text) };
    const raw = await mcp.callToolRaw(step.tool, args);
    const out = raw.structuredContent ?? JSON.parse(raw.content?.[0]?.text ?? 'null');
    renderOutcome(step, out, raw._meta);
    speak(out?.say);
    await mountApp(out?.verdict ? step.tool : null, args, raw);
  } catch (err) {
    bubble('alexa', `Something went wrong: ${esc(err.message)}`, 'error');
  } finally {
    thinking(false);
    refreshPanels();
  }
}

function renderOutcome(step, out, meta = {}) {
  if (step.tool === 'propose_policy_change') {
    renderProposal(out);
    return;
  }
  if (out?.deals) {
    const removed = meta['decision-gate/injection-removed'];
    bubble('alexa', `Here are today's deals from DealsBot: ${out.deals.map((d) => `${esc(d.title)} for ${money(d.price)}`).join('; ')}.`);
    if (removed) {
      bubble('alexa', `Heads up: Decision Gate removed hidden instructions from DealsBot's reply before I read it (${removed.map(esc).join(', ')}).`, 'hold');
      speak('Heads up. Decision Gate removed hidden instructions from that store\'s reply.');
    }
    renderDecision({
      verdict: removed ? 'filtered' : 'passthrough',
      reasons: removed
        ? [`dealsbot is not a trusted server, so its read-only output was filtered`, `prompt injection removed: ${removed.join(', ')}`, 'the gift-card order it tried to trigger never happened']
        : ['read-only output from an untrusted server, filtered for injection'],
    });
    return;
  }
  if (step.tool === 'simulate_policy') {
    const lines = out.changes.map((c) => `${esc(c.action)}: ${c.before} → ${c.after}`).join('<br>');
    bubble('alexa', `I replayed your last ${out.replayed} decisions. ${out.changed ? `${out.changed} would change:<br><small>${lines}</small>` : 'None would change.'}`);
    renderDecision({ verdict: 'dry-run', reasons: [`${out.replayed} decisions replayed`, `${out.changed} would flip`] });
    return;
  }
  if (step.tool === 'update_policy') {
    bubble('alexa', out.ok ? `Done. Auto-approve limit is now ${money(out.policy.purchases.auto_approve_limit)}. ${out.impact.changed} recent decision(s) would now go differently.` : esc(out.message));
    return;
  }
  if (!out.verdict) {
    // Read-only passthrough tool: show the brand server's answer.
    if (out.doors) bubble('alexa', `Front door is ${out.doors.front_door}, back door is ${out.doors.back_door}, garage is ${out.doors.garage}.`);
    else if (out.balance !== undefined) bubble('alexa', `Your QuickPay balance is ${money(out.balance)}.`);
    else bubble('alexa', `<pre class="raw">${esc(JSON.stringify(out, null, 2))}</pre>`);
    renderDecision({ verdict: 'passthrough', reasons: ['read-only tool on a trusted server, forwarded without a check'] });
    return;
  }
  if (out.replayed) {
    bubble('alexa', `Same payment retried with the same Idempotency-Key, so I returned the original decision (${esc(out.verdict)}). Nothing was charged twice.`, 'allow');
    renderDecision({ ...out, verdict: 'replayed', reasons: ['same Idempotency-Key and same body as an earlier call', `original decision returned unchanged: ${out.verdict}`, 'no second charge, nothing re-run'] });
    return;
  }
  bubble('alexa', esc(out.say), out.verdict);
  renderDecision(out);
}

function renderProposal(p) {
  const impact = p.impact ? ` Replaying recent decisions, ${p.impact.changed} of ${p.impact.replayed} would change.` : '';
  const html = `${esc(p.summary || p.message)}${p.ok ? `${impact}<div class="bubble-actions"><button type="button" class="small" data-apply='${esc(JSON.stringify(p.changes))}'>Apply (adult passcode)</button></div>` : ''}`;
  bubble('alexa', html, p.ok ? '' : 'block');
  speak(p.ok ? `${p.summary}${impact} An adult can apply it.` : p.message);
  renderDecision({
    verdict: p.ok ? 'proposal' : 'rejected',
    reasons: [
      `drafted by ${p.source === 'bedrock' ? `Amazon Bedrock (${p.model}, ${p.latency_ms} ms)` : 'offline phrase rules'}${p.bedrock_error ? ` after Bedrock error ${p.bedrock_error}` : ''}`,
      p.ok ? 'validated against the policy schema (zod)' : (p.errors?.join('; ') || p.message),
      ...(p.ok ? [`changes: ${JSON.stringify(p.changes)}`, 'nothing changes until an adult applies it'] : []),
    ],
  });
}

$('chat').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-apply]');
  if (!btn) return;
  btn.disabled = true;
  const r = await mcp.callTool('update_policy', { changes: JSON.parse(btn.dataset.apply) });
  bubble('alexa', r.ok ? `Rule change applied. ${r.impact.changed} recent decision(s) would now go differently.` : esc(r.message), r.ok ? 'allow' : 'block');
  if (!r.ok) btn.disabled = false;
  refreshPanels();
});

function renderDecision(d) {
  const el = $('decision');
  el.classList.remove('empty');
  const score = d.risk_score ?? 0;
  const exec = d.execution && (d.execution.order_id || d.execution.transfer_id || (d.execution.state && `${d.execution.door} ${d.execution.state}`));
  el.innerHTML = `
    <div class="verdict-row">
      <span class="verdict v-${esc(d.verdict)}">${esc(d.verdict)}</span>
      ${d.risk_score !== undefined ? `<div class="risk"><div class="risk-bar"><span style="width:${score}%"></span></div><span class="risk-num">risk ${score}</span></div>` : ''}
    </div>
    ${d.reasons?.length ? `<ul class="reasons">${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${d.scam_signals ? `<div class="scam">Scam Shield: ${d.scam_signals.map(esc).join(' · ')}</div>` : ''}
    ${d.integrity ? `<div class="integrity">
        <div><b>Add-on guard:</b> ${esc(d.integrity.status === 'changed' ? 'manifest changed since approval' : 'hidden instructions in tool text')}</div>
        <code>pinned  ${esc(d.integrity.pinned_hash.slice(0, 16))}…</code><br>
        <code>now     ${esc(d.integrity.current_hash.slice(0, 16))}…</code>
        ${d.integrity.findings?.length ? `<div class="small">found: ${[...new Set(d.integrity.findings.map((f) => f.kind))].map(esc).join(', ')}</div>` : ''}
      </div>` : ''}
    <dl class="meta">
      ${d.decision_id ? `<dt>decision</dt><dd>${esc(d.decision_id)}</dd>` : ''}
      ${d.latency_ms !== undefined ? `<dt>latency</dt><dd>${d.decision_ms} ms rules · ${d.latency_ms} ms total</dd>` : ''}
      ${d.checkout ? `<dt>checkout</dt><dd>${esc(d.checkout.phase)} · ${esc(d.checkout.session_id)} · ${money(d.checkout.total)}${d.checkout.price_drift_pct != null ? ` · +${d.checkout.price_drift_pct}% vs create` : ''}</dd>` : ''}
      ${d.code ? `<dt>code</dt><dd>${esc(d.code)}</dd>` : ''}
      ${d.second_opinion ? `<dt>2nd opinion</dt><dd>${d.second_opinion.raise ? `flagged: ${esc(d.second_opinion.reason)}` : 'looks fine'} · ${esc(d.second_opinion.model)} · ${d.second_opinion.latency_ms}ms</dd>` : ''}
      ${d.explanation_source ? `<dt>explanation</dt><dd>${esc(d.explanation_source)}${d.explanation_model ? ` · ${esc(d.explanation_model)} · ${d.explanation_latency_ms}ms` : ''}</dd>` : ''}
      ${d.confirmation ? `<dt>confirmation</dt><dd>${esc(d.confirmation.id)} · needs ${esc(d.confirmation.required_approver)}</dd>` : ''}
      ${d.approval ? `<dt>approval</dt><dd>${esc(d.approval.status)}${d.approval.approver ? ` by ${esc(d.approval.approver)}` : ''}</dd>` : ''}
      ${d.notified ? `<dt>notified</dt><dd>${esc(d.notified)}</dd>` : ''}
      ${exec ? `<dt>executed</dt><dd>${esc(exec)}</dd>` : d.decision_id && d.verdict !== 'allow' ? '<dt>executed</dt><dd>not sent to the brand server</dd>' : ''}
    </dl>`;
}

// ---------- MCP Apps host (io.modelcontextprotocol/ui, spec 2026-01-26) ----------
// A gated tool's _meta.ui.resourceUri names a ui:// resource. We read it once over MCP,
// render it in a sandboxed iframe (opaque origin), and bridge postMessage JSON-RPC:
// ui/initialize, tool-input/tool-result notifications, size changes, and tools/call
// proxied back to the Decision Gate server.
const tools = new Map();
const uiCache = new Map();
let detachApp = null;

async function mountApp(toolName, args, result) {
  const uri = tools.get(toolName)?._meta?.ui?.resourceUri;
  const host = $('app-view');
  if (!uri) {
    detachApp?.();
    host.hidden = true;
    return;
  }
  if (!uiCache.has(uri)) {
    const r = await mcp.request('resources/read', { uri });
    uiCache.set(uri, r.contents[0].text);
  }
  detachApp?.();
  host.hidden = false;
  $('app-uri').textContent = uri;
  const frame = document.createElement('iframe');
  frame.sandbox = 'allow-scripts allow-forms';
  frame.title = 'Decision Gate MCP App';
  frame.srcdoc = uiCache.get(uri);
  $('app-frame').replaceChildren(frame);

  const post = (msg) => frame.contentWindow?.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  const onMessage = async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0' || !m.method) return;
    switch (m.method) {
      case 'ui/initialize':
        return post({ id: m.id, result: {
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'alexa-plus-simulator', version: '1.0.0' },
          hostCapabilities: { serverTools: {} },
          hostContext: { theme: 'dark', displayMode: 'inline', availableDisplayModes: ['inline'], toolInfo: { tool: tools.get(toolName) } },
        } });
      case 'ui/notifications/initialized':
        post({ method: 'ui/notifications/tool-input', params: { arguments: args } });
        return post({ method: 'ui/notifications/tool-result', params: result });
      case 'ui/notifications/size-changed':
        frame.style.height = `${Math.min(Math.max(m.params.height, 80), 900)}px`;
        return;
      case 'tools/call':
        try {
          const r = await mcp.request('tools/call', m.params, 'app');
          post({ id: m.id, result: r });
          if (['confirm_action', 'answer_challenge'].includes(m.params.name)) refreshPanels();
        } catch (err) {
          post({ id: m.id, error: { code: -32000, message: err.message } });
        }
        return;
      default:
        if (m.id !== undefined) post({ id: m.id, error: { code: -32601, message: `Method not supported by this host: ${m.method}` } });
    }
  };
  window.addEventListener('message', onMessage);
  detachApp = () => window.removeEventListener('message', onMessage);
}

// ---------- side panels ----------
let policyCache;
async function refreshPanels() {
  try {
    const [log, policy] = await Promise.all([
      mcp.callTool('get_audit_log', { limit: 30 }, 'ui'),
      mcp.callTool('get_policy', {}, 'ui'),
    ]);
    policyCache = policy;
    renderImpactStrip(log.impact);
    renderAddons(log.addons);
    renderAudit(log);
    renderPhone(log);
    renderPolicy(policy);
  } catch (err) {
    console.error(err);
  }
}

function renderImpactStrip(s) {
  if (!s) return;
  const stat = (value, label, cls = '') => `<div class="stat ${cls}"><b>${value}</b><span>${label}</span></div>`;
  $('impact-strip').innerHTML = [
    stat(money(s.money_stopped), 'stopped or held', 'big'),
    stat(s.scams_held, 'scams held'),
    stat(s.blocked, 'blocked'),
    stat(s.injections_removed, 'injections removed'),
    stat(s.addon_attacks, 'rogue add-on calls stopped'),
    stat(s.approvals, 'adult approvals'),
    stat(s.auto_allowed, 'auto-approved, no friction'),
  ].join('');
}

// ---------- voice (Web Speech API; typing still works without it) ----------
// Replies are spoken by Amazon Polly (server /tts); browser speech covers any line Polly can't.
let playing = null;
async function speak(text) {
  if (!text || !$('voice').checked) return;
  const line = String(text).replace(/<[^>]+>/g, '');
  playing?.pause();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  try {
    const res = await fetch('/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line }) });
    if (!res.ok) throw new Error((await res.json()).error);
    playing = new Audio(URL.createObjectURL(await res.blob()));
    await playing.play();
    setVoiceLabel(`Amazon Polly · ${res.headers.get('x-voice') ?? 'neural'}`);
    return;
  } catch (err) {
    setVoiceLabel(`browser voice for this line (Amazon Polly: ${err.message})`);
  }
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(line);
  u.rate = 1.03;
  speechSynthesis.speak(u);
}

function setVoiceLabel(text) {
  $('voice-src').textContent = text;
}

function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('mic').hidden = true; return; }
  let rec = null;
  $('mic').addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = true;
    let finalText = '';
    rec.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join('');
      $('utterance').value = text;
      if (e.results[e.results.length - 1].isFinal) finalText = text;
    };
    rec.onend = () => {
      rec = null;
      $('mic').classList.remove('on');
      $('ring').classList.remove('listening');
      if (finalText) handle(finalText);
    };
    rec.onerror = () => {};
    $('mic').classList.add('on');
    $('ring').classList.add('listening');
    speechSynthesis?.cancel();
    rec.start();
  });
}

function renderAudit(log) {
  const c = log.chain;
  $('chain').className = `chain ${c.intact ? 'ok' : 'bad'}`;
  $('chain').textContent = c.intact ? `Chain intact · ${c.entries} entries` : `Chain BROKEN at entry #${c.broken_at}`;
  $('audit').innerHTML = log.entries.map((e) => {
    const d = e.data;
    const text = e.kind === 'decision'
      ? `<span class="verdict small v-${esc(d.verdict)}">${esc(d.verdict)}</span> ${esc(d.action.description || d.action.type)} <span class="muted">· ${esc(d.context.speaker.id ?? d.context.speaker.role)} · ${esc(d.context.local_time ?? '')}</span>`
      : e.kind === 'confirmation' ? `approval <b>${esc(d.outcome)}</b> by ${esc(d.approver)}`
      : e.kind === 'execution' ? `executed ${esc(d.tool)} ${d.ok ? '✓' : '✗'}`
      : e.kind === 'policy_update' ? `rules change <b>${esc(d.outcome)}</b> by ${esc(d.approver)}`
      : e.kind === 'injection_blocked' ? `<span class="verdict small v-filtered">filtered</span> injection removed from ${esc(d.server)} ${esc(d.tool)}`
      : e.kind === 'addon_integrity' ? `<span class="verdict small v-block">${esc(d.status)}</span> add-on ${esc(d.server)} failed its integrity check`
      : e.kind === 'addon_pinned' ? `add-on ${esc(d.server)} re-approval ${d.ok ? 'applied' : 'refused'} by ${esc(d.approver)}`
      : e.kind === 'checkout' ? `checkout ${esc(d.phase)} ${esc(d.session_id)}: <b>${esc(d.outcome)}</b>${d.verdict ? ` (${esc(d.verdict)})` : ''}`
      : e.kind === 'challenge' ? `safe-word answer <b>${esc(d.outcome)}</b>`
      : `notified ${esc(d.to)}`;
    const broken = !c.intact && e.seq >= c.broken_at;
    return `<li class="${broken ? 'broken' : ''}"><span class="seq">#${e.seq}</span><div><div>${text}</div><code title="${esc(e.hash)}">${esc(e.hash.slice(0, 16))}… ← ${esc(e.prev_hash.slice(0, 8))}</code></div></li>`;
  }).join('');
}

function renderPhone(log) {
  const n = log.notifications;
  $('ntf-count').hidden = !n.length;
  $('ntf-count').textContent = n.length;
  $('notifications').innerHTML = n.length
    ? n.filter((x) => x.to === policyCache?.transfers.caregiver).map((x) => `<div class="ntf" role="status"><div class="ntf-app">SafeWord</div>${esc(x.message)}<div class="muted small">${new Date(x.ts).toLocaleTimeString()}</div></div>`).join('') || '<p class="muted">No alerts for Alex.</p>'
    : '<p class="muted">No alerts. SafeWord will alert Alex (the guardian) here.</p>';
  const approvers = Object.entries(policyCache?.members ?? {}).filter(([, m]) => m.can_approve);
  $('pending').innerHTML = log.pending.length
    ? log.pending.map((p) => {
      const guardianOnly = p.required === 'caregiver';
      const label = { caregiver: 'guardian only', adult: 'any adult', safe_word: 'family safe word' }[p.required] ?? p.required;
      return `
      <form class="pend" data-id="${esc(p.id)}" data-required="${esc(p.required)}" aria-label="Pending: ${esc(p.action)}">
        <div><b>${esc(p.action)}</b><div class="muted small">${esc(p.id)} · needs ${esc(label)} · ${p.attempts} failed</div></div>
        ${p.required === 'safe_word' ? `
        <div class="pend-row">
          <input name="answer" placeholder="safe-word answer" aria-label="Safe-word answer">
          <button data-act="answer">Answer</button>
          <button type="button" class="secondary" data-act="escalate">Ask guardian</button>
        </div>` : `
        <div class="pend-row">
          <select name="approver" aria-label="Approver">${approvers.map(([id, m]) => `<option value="${id}" ${guardianOnly && id === policyCache.transfers.caregiver ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
          <input name="passcode" type="password" placeholder="passcode" inputmode="numeric" aria-label="Passcode">
        </div>
        <div class="pend-row">
          <button data-act="approve">Approve</button>
          ${guardianOnly ? '<button type="button" class="danger" data-act="deny">Deny</button>' : '<button type="button" class="secondary" data-act="escalate">Ask guardian</button>'}
        </div>`}
      </form>`;
    }).join('')
    : '<p class="muted">Nothing pending.</p>';
}

function renderAddons(list = []) {
  $('addons').innerHTML = list.map((a) => `
    <div class="addon ${esc(a.status)}">
      <div class="addon-head">
        <b>${esc(a.server)}</b>
        <span class="verdict small v-${a.status === 'ok' ? 'allow' : 'block'}">${a.status === 'ok' ? 'pinned' : esc(a.status)}</span>
        ${a.trusted ? '<span class="chip">trusted</span>' : '<span class="chip">untrusted</span>'}
      </div>
      <code title="${esc(a.pinned_hash)}">sha256 ${esc(a.pinned_hash.slice(0, 20))}…</code>
      <div class="muted small">${a.tools.length} tools · pinned ${new Date(a.pinned_at).toLocaleTimeString()}</div>
      ${a.findings?.length ? `<ul class="small">${a.findings.slice(0, 5).map((f) => `<li><b>${esc(f.kind)}</b> in ${esc(f.tool)}.${esc(f.field)}: “${esc(f.excerpt)}”</li>`).join('')}</ul>` : ''}
      <div class="btns">
        <button type="button" class="secondary small" data-verify="${esc(a.server)}">Verify now</button>
        ${a.status !== 'ok' ? `<button type="button" class="small" data-pin="${esc(a.server)}">Re-approve (adult)</button>` : ''}
      </div>
    </div>`).join('');
}

function renderPolicy(p) {
  $('household').textContent = p.household;
  const members = Object.values(p.members).map((m) => `<span class="chip">${esc(m.name)} <i>${esc(m.role)}</i></span>`).join('');
  $('policy').innerHTML = `
    <h3>${esc(p.household)}</h3>
    <div class="chips">${members}</div>
    <table>
      <tr><th>Auto-approve purchases</th><td>up to ${money(p.purchases.auto_approve_limit)}</td></tr>
      <tr><th>Hard block above</th><td>${money(p.purchases.hard_block_above)}</td></tr>
      <tr><th>Blocked categories</th><td>${p.purchases.blocked_categories.map(esc).join(', ')}</td></tr>
      <tr><th>Children can buy</th><td>${p.purchases.children_can_purchase ? 'yes' : 'no'}</td></tr>
      <tr><th>"Unusual spend" flag</th><td>${p.purchases.anomaly_multiplier}x the household median</td></tr>
      <tr><th>Transfers auto-approved</th><td>up to ${money(p.transfers.auto_approve_limit)}</td></tr>
      <tr><th>Scam Shield hold</th><td>${p.transfers.cooling_off_minutes} min, released only by ${esc(p.members[p.transfers.caregiver]?.name)}</td></tr>
      <tr><th>Can unlock doors</th><td>${p.access.unlock_roles.map(esc).join(', ')}</td></tr>
      <tr><th>Quiet hours</th><td>${p.quiet_hours.start} – ${p.quiet_hours.end}</td></tr>
      <tr><th>Trusted MCP servers</th><td>${p.trusted_servers.map(esc).join(', ')}</td></tr>
    </table>`;
}

function proposedChanges() {
  return { purchases: { auto_approve_limit: +$('limit').value }, transfers: { cooling_off_minutes: +$('cooling').value } };
}

function renderImpact(r, applied) {
  $('impact').innerHTML = `<b>${applied ? 'Applied.' : 'Dry run.'}</b> Replayed ${r.replayed} past decisions; ${r.changed} would change.` +
    (r.changes.length ? `<ul>${r.changes.map((c) => `<li>${esc(c.action)}: <span class="verdict small v-${c.before}">${c.before}</span> → <span class="verdict small v-${c.after}">${c.after}</span></li>`).join('')}</ul>` : '');
}

// ---------- wiring ----------
function initUi() {
  initMic();
  $('scenarios').innerHTML = SCENARIOS.map((s, i) => `<button type="button" class="chip-btn" data-i="${i}">${esc(s.label)}</button>`).join('');
  $('scenarios').addEventListener('click', async (e) => {
    const s = SCENARIOS[e.target.dataset.i];
    if (!s) return;
    $('speaker').value = s.speaker;
    $('time').value = s.time;
    $('home').checked = s.home;
    $('clock-display').textContent = s.time;
    $('utterance').value = s.say ?? '';
    if (s.before) await s.before();
    if (s.run) {
      thinking(true);
      try { await s.run(); } catch (err) { bubble('alexa', `Something went wrong: ${esc(err.message)}`, 'error'); }
      thinking(false);
      refreshPanels();
      return;
    }
    handle(s.say);
  });
  $('say-form').addEventListener('submit', (e) => { e.preventDefault(); handle($('utterance').value); });
  $('time').addEventListener('input', () => { $('clock-display').textContent = $('time').value; });
  $('show-ui').addEventListener('change', (e) => {
    showUi = e.target.checked;
    document.querySelectorAll('.msg.ui').forEach((li) => { li.hidden = !showUi; });
  });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${b.dataset.tab}`; });
  }));
  $('dry-run').addEventListener('click', async () => renderImpact(await mcp.callTool('simulate_policy', { changes: proposedChanges() }), false));
  $('policy-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await mcp.callTool('update_policy', { changes: proposedChanges() });
    if (r.ok) renderImpact(r.impact, true);
    else $('impact').textContent = r.message;
    refreshPanels();
  });
  const pendingAction = async (f, act) => {
    const id = f.dataset.id;
    const done = (r) => (r.execution?.transfer_id ? `Transfer ${esc(r.execution.transfer_id)} sent.` : r.execution?.order_id ? `Order ${esc(r.execution.order_id)} placed.` : 'Done.');
    let r;
    if (act === 'answer') {
      r = await mcp.callTool('answer_challenge', { confirmation_id: id, answer: f.answer.value });
      bubble('alexa', r.ok ? `Safe word matches. ${done(r)}` : esc(r.message), r.ok ? 'allow' : 'block');
    } else if (act === 'escalate') {
      r = await mcp.callTool('request_guardian_approval', { confirmation_id: id, note: 'asked from the device' });
      bubble('alexa', r.ok ? `I've asked ${esc(r.guardian)} to approve this on their phone.` : esc(r.message), r.ok ? 'hold' : 'block');
    } else if (act === 'deny') {
      r = await mcp.callTool('guardian_decide', { confirmation_id: id, guardian: f.approver.value, passcode: f.passcode.value, decision: 'deny' });
      bubble('alexa', r.ok ? `${esc(policyCache.members[f.approver.value].name)} denied it from their phone. Nothing was sent.` : esc(r.message), 'block');
    } else {
      const tool = f.dataset.required === 'caregiver' ? 'guardian_decide' : 'confirm_action';
      const args = tool === 'guardian_decide'
        ? { confirmation_id: id, guardian: f.approver.value, passcode: f.passcode.value, decision: 'approve' }
        : { confirmation_id: id, approver: f.approver.value, passcode: f.passcode.value };
      r = await mcp.callTool(tool, args);
      bubble('alexa', r.ok ? `Approved from ${esc(policyCache.members[f.approver.value].name)}'s phone. ${done(r)}` : esc(r.message), r.ok ? 'allow' : 'block');
    }
    speak(r.ok ? (act === 'deny' ? 'Denied. Nothing was sent.' : 'Done.') : r.message);
    refreshPanels();
  };
  $('pending').addEventListener('submit', (e) => {
    e.preventDefault();
    pendingAction(e.target, e.submitter?.dataset.act ?? (e.target.answer ? 'answer' : 'approve'));
  });
  $('pending').addEventListener('click', (e) => {
    const b = e.target.closest('button[type=button][data-act]');
    if (b) pendingAction(b.closest('form'), b.dataset.act);
  });
  $('addons').addEventListener('click', async (e) => {
    const v = e.target.closest('[data-verify]');
    const p = e.target.closest('[data-pin]');
    if (v) {
      const r = await mcp.callTool('verify_addon', { server: v.dataset.verify });
      bubble('alexa', r.ok ? `${esc(r.server)} matches its approved manifest.` : `${esc(r.server)}: ${esc(r.status)}. ${r.changed?.length ? `Changed tools: ${r.changed.map(esc).join(', ')}.` : ''} ${r.findings.length} suspicious pattern(s).`, r.ok ? 'allow' : 'block');
    }
    if (p) {
      const r = await mcp.callTool('pin_addon', { server: p.dataset.pin });
      bubble('alexa', r.ok ? `${esc(r.server)} re-approved.` : esc(r.message), r.ok ? 'allow' : 'block');
    }
    refreshPanels();
  });
  $('tamper').addEventListener('click', async () => {
    const r = await fetch('/demo/tamper', { method: 'POST' }).then((x) => x.json());
    if (!r.ok) alert(r.message);
    refreshPanels();
  });
}

async function boot() {
  initUi();
  fetch('/tts/status').then((r) => r.json()).then((s) => setVoiceLabel(s.ok === false ? `browser voice (Amazon Polly: ${s.error})` : `Amazon Polly · ${s.voice}`)).catch(() => setVoiceLabel('browser voice'));
  try {
    const init = await mcp.initialize();
    const list = (await mcp.listTools()).tools;
    list.forEach((t) => tools.set(t.name, t));
    $('conn-dot').classList.add('on');
    $('conn-text').textContent = `${init.serverInfo.title ?? init.serverInfo.name} · ${init.protocolVersion} · ${list.length} tools`;
    const p = await mcp.callTool('get_policy', {}, 'ui');
    $('limit').value = p.purchases.auto_approve_limit;
    $('cooling').value = p.transfers.cooling_off_minutes;
    refreshPanels();
  } catch (err) {
    $('conn-text').textContent = `Could not connect: ${err.message}`;
  }
}

boot();
