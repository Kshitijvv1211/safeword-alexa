import { createHash } from 'node:crypto';
import { canonical } from './audit.js';

// Checkout guard for Alexa+-style checkout sessions (Create → Complete, with an
// Idempotency-Key on each state-changing call, as in the Alexa+ checkout docs).
// It adds three checks on top of the household rules:
//   - idempotent replay: same key + same body returns the original decision, never re-runs it;
//     same key + different body is rejected (idempotency_conflict)
//   - price drift: the total at Complete is much higher than at Create
//   - duplicate order: the same items from the same merchant were completed minutes ago

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function totalOf(session) {
  const t = session.totals?.find((x) => x.type === 'total');
  if (t) return Number(t.amount);
  return (session.line_items ?? []).reduce((s, li) => s + Number(li.item?.price ?? 0) * Number(li.quantity ?? 1), 0);
}

function signature(merchant, items) {
  return sha256(canonical({ merchant, items: [...items].map((li) => [li.item.id, li.quantity]).sort() }));
}

export class CheckoutGuard {
  constructor({ gate }) {
    this.gate = gate;
    this.keys = new Map();      // idempotency key -> { hash, result }
    this.sessions = new Map();  // session id -> { created_total, sig, completed_at }
  }

  async evaluate({ phase, idempotency_key, merchant, session }, context) {
    const gate = this.gate;
    const now = gate.clock();
    const bodyHash = sha256(canonical({ phase, merchant, session }));
    const log = (data) => gate.audit.append('checkout', { phase, session_id: session.id, idempotency_key, ...data }, now);

    const prior = this.keys.get(idempotency_key);
    if (prior) {
      if (prior.hash === bodyHash) {
        log({ outcome: 'replayed', verdict: prior.result.verdict });
        return { ...prior.result, replayed: true, note: 'Same Idempotency-Key and body: original decision returned, nothing re-run, nobody charged twice.' };
      }
      log({ outcome: 'idempotency_conflict' });
      return {
        verdict: 'block',
        code: 'idempotency_conflict',
        risk_score: 90,
        reasons: ['this Idempotency-Key was already used for a different request; refusing so nothing is charged twice'],
        say: "Something doesn't match with this payment, so I've stopped it. Nothing was charged.",
      };
    }

    const total = totalOf(session);
    const items = session.line_items ?? [];
    const sig = signature(merchant, items);
    const signals = {};
    const known = this.sessions.get(session.id);
    if (phase === 'complete' && known?.created_total) {
      signals.created_total = known.created_total;
      signals.price_drift_pct = ((total - known.created_total) / known.created_total) * 100;
    }
    const windowMs = gate.policy.checkout.duplicate_window_minutes * 60_000;
    for (const [id, other] of this.sessions) {
      if (id !== session.id && other.sig === sig && other.completed_at && now - other.completed_at <= windowMs) {
        signals.duplicate_minutes_ago = (now - other.completed_at) / 60_000;
      }
    }

    const titles = items.map((li) => `${li.quantity > 1 ? `${li.quantity} x ` : ''}${li.item.title ?? li.item.id}`);
    const main = [...items].sort((a, b) => (b.item.price ?? 0) * b.quantity - (a.item.price ?? 0) * a.quantity)[0];
    const action = {
      type: 'purchase',
      amount: +total.toFixed(2),
      currency: session.currency,
      merchant,
      category: main?.item.category ?? 'other',
      item: titles.length === 1 ? titles[0] : `${titles.length} items`,
      quantity: Math.max(1, ...items.map((li) => li.quantity ?? 1)),
      description: `Checkout ${titles.length === 1 ? titles[0] : `${titles.length} items`} from ${merchant}`,
      checkout_phase: phase,
      tool: 'evaluate_checkout',
    };
    const result = await gate.evaluate(action, context, { signals });

    const entry = { ...(known ?? {}), sig, merchant };
    if (phase === 'create') entry.created_total = total;
    if (phase === 'complete' && result.verdict === 'allow') entry.completed_at = now.getTime();
    this.sessions.set(session.id, entry);
    const out = {
      ...result,
      checkout: {
        phase,
        session_id: session.id,
        total,
        ...(signals.price_drift_pct != null && { created_total: signals.created_total, price_drift_pct: +signals.price_drift_pct.toFixed(1) }),
        ...(signals.duplicate_minutes_ago != null && { duplicate_minutes_ago: +signals.duplicate_minutes_ago.toFixed(1) }),
      },
    };
    this.keys.set(idempotency_key, { hash: bodyHash, result: out });
    log({ outcome: 'evaluated', verdict: result.verdict, total });
    return out;
  }
}
