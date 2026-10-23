import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog } from './audit.js';
import { evaluate } from './engine.js';
import { createExplainer } from './explain.js';
import { applyPatch, checkPasscode, defaultPolicy, hashPasscode, normalizeAnswer, PolicyPatchSchema, PolicySchema, publicPolicy } from './policy.js';
import { createAdvisor } from './advisor.js';
import { CheckoutGuard } from './checkout.js';
import { createProposer } from './proposer.js';
import { seedHistory } from './seed.js';

export const CONFIRM_TTL_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const SAFE_WORD_ATTEMPTS = 2;

const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

/**
 * The household's trust layer. Owns policy, history, pending confirmations and
 * the audit log. Transport-agnostic: the MCP layer in src/mcp calls into this.
 */
export class DecisionGate {
  constructor({ dataDir = null, policy, history, explain, propose, advise, clock = () => new Date() } = {}) {
    this.dataDir = dataDir;
    this.clock = clock;
    this.explain = explain ?? createExplainer();
    this.propose = propose ?? createProposer();
    this.advise = advise ?? createAdvisor();
    this.checkout = new CheckoutGuard({ gate: this });
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    // Parsing fills defaults for fields added after a policy file was saved.
    this.policy = PolicySchema.parse(policy ?? this.#load('policy.json') ?? defaultPolicy());
    this.history = history ?? this.#load('history.json') ?? seedHistory();
    this.audit = new AuditLog(dataDir ? join(dataDir, 'audit.jsonl') : null);
    this.pending = new Map();
    this.notifications = [];
    this.#save('policy.json', this.policy);
    this.#save('history.json', this.history);
  }

  #load(name) {
    const f = this.dataDir && join(this.dataDir, name);
    return f && existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  }

  #save(name, value) {
    if (this.dataDir) writeFileSync(join(this.dataDir, name), JSON.stringify(value, null, 2));
  }

  /**
   * Decide on an action. For confirm/hold verdicts a single-use confirmation is
   * created; `execute` (if given) runs only once that confirmation is approved.
   */
  async evaluate(action, context, { execute, signals: extra = {} } = {}) {
    const started = performance.now();
    const now = this.clock();
    const signals = { recent_actions: this.#recentMoneyActions(now, context?.speaker), ...extra };
    const d = evaluate(action, context, this.policy, this.history, signals);
    const decision_ms = +(performance.now() - started).toFixed(2);
    // Optional AI second opinion. It can only raise caution (allow -> confirm), never lower it.
    const advice = await this.advise(d);
    if (advice?.raise && d.verdict === 'allow') {
      d.verdict = 'confirm';
      d.risk_score = Math.max(d.risk_score, 40);
      d.reasons = [`a second check flagged this: ${advice.reason}`, ...d.reasons];
      d.say = `I can do that, but I need an adult to approve it first, because ${advice.reason}.`;
    }
    const decision_id = newId('dec');
    const explanation = await this.explain(d);
    const result = {
      decision_id,
      verdict: d.verdict,
      risk_score: d.risk_score,
      reasons: d.reasons,
      say: explanation.text,
      explanation_source: explanation.source,
      ...(explanation.model && { explanation_model: explanation.model, explanation_latency_ms: explanation.latency_ms }),
      ...(advice && { second_opinion: advice }),
      ...(d.scam && { scam_signals: d.scam.hits.map((h) => h.label) }),
    };

    if (d.verdict === 'confirm' || d.verdict === 'hold') {
      const hold = d.verdict === 'hold';
      const ttl = hold ? this.policy.transfers.cooling_off_minutes * 60_000 : CONFIRM_TTL_MS;
      const c = {
        id: newId(hold ? 'hold' : 'conf'),
        decision_id,
        verdict: d.verdict,
        required: hold ? 'caregiver' : d.challenge === 'safe_word' ? 'safe_word' : 'adult',
        speaker_id: d.context.speaker.id,
        expires_at: new Date(now.getTime() + ttl).toISOString(),
        attempts: 0,
        status: 'pending',
        action: d.action,
        execute,
      };
      this.pending.set(c.id, c);
      result.confirmation = {
        id: c.id,
        required_approver: c.required,
        expires_at: c.expires_at,
        max_attempts: c.required === 'safe_word' ? SAFE_WORD_ATTEMPTS : MAX_ATTEMPTS,
        ...(c.required === 'safe_word' && { question: this.policy.safe_word.question }),
      };
      if (hold) {
        const caregiverId = this.policy.transfers.caregiver;
        this.notify(caregiverId, `Scam Shield paused ${d.action.description || 'a transfer'} requested by ${d.context.speaker.id ?? 'a family member'}. Reasons: ${d.reasons.join('; ')}. Approve with confirmation ${c.id} or let it expire.`, c.id);
        result.notified = this.policy.members[caregiverId]?.name ?? caregiverId;
      }
    }

    this.audit.append('decision', {
      decision_id,
      verdict: d.verdict,
      risk_score: d.risk_score,
      reasons: d.reasons,
      action: d.action,
      context: d.context,
      signals,
      explanation_source: explanation.source,
      confirmation_id: result.confirmation?.id,
    }, now);

    if (d.verdict === 'allow') {
      result.execution = execute ? await this.#run(decision_id, d.action, execute) : undefined;
    }
    result.decision_ms = decision_ms;
    result.latency_ms = +(performance.now() - started).toFixed(1);
    return result;
  }

  /** This speaker's purchases and transfers (not blocked) within the policy's speed window. */
  #recentMoneyActions(now, speaker = {}) {
    const since = now.getTime() - (this.policy.velocity.window_minutes * 60_000);
    const who = (s) => s?.id ?? s?.role ?? 'unknown';
    return this.audit.entries.filter((e) => e.kind === 'decision'
      && ['purchase', 'transfer'].includes(e.data.action?.type)
      && e.data.action.checkout_phase !== 'create'
      && e.data.verdict !== 'block'
      && who(e.data.context?.speaker) === who(speaker)
      && new Date(e.ts).getTime() >= since).length;
  }

  async confirm(confirmationId, approverId, passcode) {
    const c = this.pending.get(confirmationId);
    const now = this.clock();
    const fail = (status, message) => {
      this.audit.append('confirmation', { confirmation_id: confirmationId, approver: approverId, outcome: status }, now);
      return { ok: false, status, message };
    };
    if (!c) return fail('not_found', 'No pending confirmation with that id.');
    if (c.status !== 'pending') return fail(c.status, `This confirmation is already ${c.status}.`);
    if (now > new Date(c.expires_at)) {
      c.status = 'expired';
      return fail('expired', 'This confirmation has expired. Ask again to start over.');
    }
    if (c.required === 'safe_word') return fail('needs_safe_word', `This needs the family safe word: ${this.policy.safe_word.question} Answer it with answer_challenge, or ask a guardian with request_guardian_approval.`);
    const member = this.policy.members[approverId];
    const roleOk = c.required === 'caregiver'
      ? approverId === this.policy.transfers.caregiver
      : member?.role === 'adult';
    if (!member || !roleOk || !checkPasscode(passcode, member.passcode_hash)) {
      c.attempts += 1;
      if (c.attempts >= MAX_ATTEMPTS) {
        c.status = 'locked';
        return fail('locked', 'Too many failed attempts. This request is now locked.');
      }
      const who = c.required === 'caregiver' ? 'the caregiver' : 'an adult';
      return fail('denied', `That approval did not check out. It needs ${who} with the right passcode. ${MAX_ATTEMPTS - c.attempts} attempt(s) left.`);
    }
    c.status = 'used';
    this.audit.append('confirmation', { confirmation_id: c.id, decision_id: c.decision_id, approver: approverId, outcome: 'approved' }, now);
    const execution = c.execute ? await this.#run(c.decision_id, c.action, c.execute) : undefined;
    return { ok: true, status: 'approved', decision_id: c.decision_id, action: c.action, execution };
  }

  /** Answer the family safe-word question. Two wrong answers lock the action and alert the guardians. */
  async answerChallenge(confirmationId, answer) {
    const c = this.pending.get(confirmationId);
    const now = this.clock();
    const log = (outcome) => this.audit.append('challenge', { confirmation_id: confirmationId, outcome }, now);
    if (!c || c.required !== 'safe_word') return { ok: false, status: 'not_found', message: 'No safe-word challenge with that id.' };
    if (c.status !== 'pending') return { ok: false, status: c.status, message: `This request is already ${c.status}.` };
    if (now > new Date(c.expires_at)) {
      c.status = 'expired';
      return { ok: false, status: 'expired', message: 'This request has expired.' };
    }
    if (!checkPasscode(normalizeAnswer(answer), this.policy.safe_word.answer_hash)) {
      c.attempts += 1;
      log('wrong');
      if (c.attempts >= SAFE_WORD_ATTEMPTS) {
        c.status = 'locked';
        const speaker = c.speaker_id;
        for (const [id, m] of Object.entries(this.policy.members)) {
          if (m.role === 'adult') this.notify(id, `Safe word failed twice for "${c.action.description}" (voice identified as ${speaker ?? 'unknown'}). The request is locked. If that wasn't really them, the voice may be cloned.`, c.id);
        }
        return { ok: false, status: 'locked', message: "That's not the safe word. I've locked this request and alerted the family." };
      }
      return { ok: false, status: 'wrong_answer', message: `That's not it. ${SAFE_WORD_ATTEMPTS - c.attempts} try left.` };
    }
    c.status = 'used';
    log('correct');
    const execution = c.execute ? await this.#run(c.decision_id, c.action, c.execute) : undefined;
    return { ok: true, status: 'approved', decision_id: c.decision_id, action: c.action, execution };
  }

  /** Escalate any pending request to the household guardian (the caregiver), who gets a phone alert. */
  requestGuardian(confirmationId, note = '') {
    const c = this.pending.get(confirmationId);
    if (!c || c.status !== 'pending') return { ok: false, message: 'No pending request with that id.' };
    if (c.required === 'safe_word' && c.attempts > 0) return { ok: false, message: 'A wrong safe word was given; this request can only be locked or answered.' };
    c.required = 'caregiver';
    const g = this.policy.transfers.caregiver;
    this.notify(g, `Guardian approval requested: ${c.action.description || c.action.type}${note ? ` (${note})` : ''}. Approve or deny ${c.id}.`, c.id);
    this.audit.append('confirmation', { confirmation_id: c.id, outcome: 'escalated_to_guardian', guardian: g }, this.clock());
    return { ok: true, confirmation_id: c.id, guardian: this.policy.members[g]?.name ?? g };
  }

  /** The guardian approves (runs the action) or denies (closes it for good). */
  async guardianDecide(confirmationId, guardianId, passcode, decision) {
    if (decision === 'approve') {
      const c = this.pending.get(confirmationId);
      if (c && c.required !== 'caregiver' && c.status === 'pending') c.required = 'caregiver';
      return this.confirm(confirmationId, guardianId, passcode);
    }
    const c = this.pending.get(confirmationId);
    if (!c || c.status !== 'pending') return { ok: false, status: 'not_found', message: 'No pending request with that id.' };
    if (guardianId !== this.policy.transfers.caregiver || !checkPasscode(passcode, this.policy.members[guardianId]?.passcode_hash)) {
      return { ok: false, status: 'denied', message: 'Only the guardian with the right passcode can decide this.' };
    }
    c.status = 'denied';
    this.audit.append('confirmation', { confirmation_id: c.id, decision_id: c.decision_id, approver: guardianId, outcome: 'denied_by_guardian' }, this.clock());
    return { ok: true, status: 'denied', message: 'Denied. The request is closed and nothing was sent.' };
  }

  async #run(decisionId, action, execute) {
    let outcome;
    try {
      outcome = await execute();
    } catch (err) {
      outcome = { isError: true, error: String(err.message ?? err) };
    }
    this.audit.append('execution', { decision_id: decisionId, tool: action.tool, ok: !outcome?.isError }, this.clock());
    if (!outcome?.isError) this.#remember(action);
    return outcome;
  }

  #remember(action) {
    if (action.type === 'purchase' && action.merchant) {
      this.history.purchases.push({ merchant: action.merchant, category: action.category ?? 'other', amount: action.amount ?? 0 });
    }
    if (action.type === 'transfer' && action.payee && !this.history.payees.includes(action.payee)) {
      this.history.payees.push(action.payee);
    }
    this.#save('history.json', this.history);
  }

  /** Adults set the family safe word; only a hash is stored. */
  setSafeWord(question, answer, approverId, passcode, minTransfer) {
    if (!this.isAdultPasscode(approverId, passcode)) return { ok: false, message: 'Only an adult with a valid passcode can set the safe word.' };
    this.policy.safe_word = { question, answer_hash: hashPasscode(normalizeAnswer(answer)), min_transfer: minTransfer ?? this.policy.safe_word?.min_transfer ?? 100 };
    this.#save('policy.json', this.policy);
    this.audit.append('policy_update', { approver: approverId, outcome: 'applied', patch: { safe_word: { question } } }, this.clock());
    return { ok: true, question, min_transfer: this.policy.safe_word.min_transfer };
  }

  isAdultPasscode(memberId, passcode) {
    const m = this.policy.members[memberId];
    return Boolean(m && m.role === 'adult' && checkPasscode(passcode, m.passcode_hash));
  }

  /** An add-on's manifest no longer matches its pin, or carries hidden instructions. Alert once per manifest version. */
  recordIntegrity(v) {
    this.audit.append('addon_integrity', { server: v.server, status: v.status, pinned_hash: v.pinned_hash, current_hash: v.current_hash, changed: v.changed, findings: v.findings.map((f) => f.kind) }, this.clock());
    this.alerted ??= new Set();
    const key = `${v.server}:${v.current_hash}`;
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    const what = v.status === 'changed' ? `silently changed its tools (${v.changed.join(', ') || 'manifest'})` : 'has hidden instructions in its tool text';
    this.notify(this.policy.transfers.caregiver, `Add-on guard: ${v.server} ${what}. All its calls are blocked until an adult reviews and re-approves it.`, v.server);
  }

  /** A brand tool's output tried to instruct the assistant; the gateway removed it. */
  recordInjection({ server, tool, patterns }) {
    this.audit.append('injection_blocked', { server, tool, patterns }, this.clock());
  }

  notify(memberId, message, ref) {
    const n = { id: newId('ntf'), to: memberId, message, ref, ts: this.clock().toISOString() };
    this.notifications.unshift(n);
    this.audit.append('notification', { to: memberId, ref }, this.clock());
    return n;
  }

  getPolicy() {
    return publicPolicy(this.policy);
  }

  /** Only a verified adult can change house rules, and every change is audited. */
  updatePolicy(patch, approverId, passcode) {
    const member = this.policy.members[approverId];
    if (!member || member.role !== 'adult' || !checkPasscode(passcode, member.passcode_hash)) {
      this.audit.append('policy_update', { approver: approverId, outcome: 'denied' }, this.clock());
      return { ok: false, message: 'Only an adult with a valid passcode can change house rules.' };
    }
    const before = this.policy;
    this.policy = applyPatch(this.policy, patch);
    this.#save('policy.json', this.policy);
    this.audit.append('policy_update', { approver: approverId, outcome: 'applied', patch }, this.clock());
    return { ok: true, policy: publicPolicy(this.policy), impact: this.#replay(before, this.policy) };
  }

  /**
   * Plain-English rule change. The proposer (Bedrock, or phrase rules offline) drafts a
   * patch; it is validated here and dry-run, but nothing changes until update_policy.
   */
  async proposePolicy(request) {
    const p = await this.propose(request, this.policy);
    const parsed = PolicyPatchSchema.safeParse(p.changes ?? {});
    const base = { request, source: p.source, ...(p.model && { model: p.model, latency_ms: p.latency_ms }), ...(p.bedrock_error && { bedrock_error: p.bedrock_error }) };
    if (!parsed.success) {
      return { ...base, ok: false, summary: p.summary, message: 'The proposed change failed validation and was discarded.', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
    }
    if (!Object.keys(parsed.data).length) return { ...base, ok: false, summary: p.summary, message: p.summary || 'No rule change found in that request.' };
    return { ...base, ok: true, summary: p.summary, changes: parsed.data, impact: this.simulatePolicy(parsed.data), next: 'An adult can apply this with update_policy.' };
  }

  /** Policy dry-run: replay recent real decisions under a proposed rule change. */
  simulatePolicy(patch, limit = 50) {
    const proposed = applyPatch(this.policy, patch);
    return this.#replay(this.policy, proposed, limit);
  }

  #replay(current, proposed, limit = 50) {
    const decisions = this.audit.recent(limit, 'decision');
    const changes = [];
    for (const e of decisions) {
      const { action, context, decision_id, signals } = e.data;
      const before = evaluate(action, context, current, this.history, signals).verdict;
      const after = evaluate(action, context, proposed, this.history, signals).verdict;
      if (before !== after) changes.push({ decision_id, action: action.description || action.type, before, after });
    }
    return { replayed: decisions.length, changed: changes.length, changes };
  }

  /** Headline numbers for the household (and the business case): what the gate stopped and let through. */
  impactStats() {
    const s = { money_stopped: 0, blocked: 0, scams_held: 0, approvals: 0, auto_allowed: 0, injections_removed: 0, addon_attacks: 0 };
    for (const e of this.audit.entries) {
      if (e.kind === 'injection_blocked') s.injections_removed += 1;
      if (e.kind === 'decision' && e.data.action?.flags?.some((f) => ['addon_changed', 'hidden_instructions', 'annotation_mismatch'].includes(f))) s.addon_attacks += 1;
      if (e.kind === 'confirmation' && e.data.outcome === 'approved') s.approvals += 1;
      if (e.kind !== 'decision') continue;
      const { verdict, action } = e.data;
      if (verdict === 'allow') s.auto_allowed += 1;
      if (verdict === 'block') s.blocked += 1;
      if (verdict === 'hold') s.scams_held += 1;
      if ((verdict === 'block' || verdict === 'hold') && action?.amount) s.money_stopped += action.amount;
    }
    s.money_stopped = +s.money_stopped.toFixed(2);
    return s;
  }

  pendingList() {
    return [...this.pending.values()]
      .filter((c) => c.status === 'pending')
      .map(({ id, verdict, required, expires_at, attempts, action }) => ({ id, verdict, required, expires_at, attempts, action: action.description || action.type }));
  }
}
