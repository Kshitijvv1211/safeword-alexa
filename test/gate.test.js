import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionGate, CONFIRM_TTL_MS } from '../src/gate/gate.js';
import { AuditLog } from '../src/gate/audit.js';

const template = async (d) => ({ text: d.say, source: 'template' });
const monitor = { type: 'purchase', amount: 479.99, merchant: 'PixelDeals Marketplace', category: 'electronics', item: 'monitor' };
const late = { speaker: { id: 'alex', role: 'adult' }, local_time: '23:00' };

function makeGate(clock) {
  return new DecisionGate({ explain: template, clock });
}

test('confirmation runs the action once with the right passcode', async () => {
  const gate = makeGate();
  let runs = 0;
  const r = await gate.evaluate(monitor, late, { execute: async () => { runs++; return { ok: true }; } });
  assert.equal(r.verdict, 'confirm');
  assert.equal(runs, 0);
  const ok = await gate.confirm(r.confirmation.id, 'sam', '4321');
  assert.equal(ok.ok, true);
  assert.equal(runs, 1);
  const again = await gate.confirm(r.confirmation.id, 'sam', '4321');
  assert.equal(again.ok, false);
  assert.equal(again.status, 'used');
  assert.equal(runs, 1);
});

test('children cannot approve and three bad tries lock the request', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(monitor, late);
  assert.equal((await gate.confirm(r.confirmation.id, 'mia', '4321')).status, 'denied');
  assert.equal((await gate.confirm(r.confirmation.id, 'sam', '0000')).status, 'denied');
  assert.equal((await gate.confirm(r.confirmation.id, 'sam', '9999')).status, 'locked');
  assert.equal((await gate.confirm(r.confirmation.id, 'sam', '4321')).status, 'locked');
});

test('confirmations expire', async () => {
  let now = new Date('2026-10-20T23:00:00Z');
  const gate = makeGate(() => now);
  const r = await gate.evaluate(monitor, late);
  now = new Date(now.getTime() + CONFIRM_TTL_MS + 1000);
  assert.equal((await gate.confirm(r.confirmation.id, 'sam', '4321')).status, 'expired');
});

test('Scam Shield holds can only be released by the caregiver', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(
    { type: 'transfer', amount: 900, payee: 'Jake Miller' },
    { speaker: { id: 'grandpa', role: 'elder' }, utterance: "it's urgent, bail money, don't tell anyone", local_time: '15:00' },
  );
  assert.equal(r.verdict, 'hold');
  assert.equal(r.notified, 'Alex');
  assert.equal(gate.notifications[0].to, 'alex');
  assert.equal((await gate.confirm(r.confirmation.id, 'grandpa', '1111')).status, 'denied');
  assert.equal((await gate.confirm(r.confirmation.id, 'sam', '4321')).status, 'denied');
  assert.equal((await gate.confirm(r.confirmation.id, 'alex', '2468')).ok, true);
});

test('policy changes need an adult passcode and report their impact', async () => {
  const gate = makeGate();
  await gate.evaluate({ type: 'purchase', amount: 35, merchant: 'FreshCart', category: 'groceries' }, { speaker: { id: 'alex', role: 'adult' }, local_time: '12:00' });
  const sim = gate.simulatePolicy({ purchases: { auto_approve_limit: 20 } });
  assert.equal(sim.changed, 1);
  assert.deepEqual([sim.changes[0].before, sim.changes[0].after], ['allow', 'confirm']);
  assert.equal(gate.policy.purchases.auto_approve_limit, 50, 'dry run changes nothing');
  assert.equal(gate.updatePolicy({ purchases: { auto_approve_limit: 20 } }, 'mia', '4321').ok, false);
  const r = gate.updatePolicy({ purchases: { auto_approve_limit: 20 } }, 'sam', '4321');
  assert.equal(r.ok, true);
  assert.equal(gate.policy.purchases.auto_approve_limit, 20);
});

test('policy patches cannot touch members or passcodes', () => {
  const gate = makeGate();
  assert.throws(() => gate.simulatePolicy({ members: { mia: { role: 'adult' } } }));
});

test('audit chain detects tampering', async () => {
  const gate = makeGate();
  await gate.evaluate(monitor, late);
  await gate.evaluate({ type: 'unlock', door: 'front door' }, { speaker: { role: 'unknown' }, local_time: '02:00', home_occupied: false });
  assert.equal(gate.audit.verify().intact, true);
  gate.audit.tamper(1, (d) => { d.verdict = 'allow'; });
  const v = gate.audit.verify();
  assert.equal(v.intact, false);
  assert.equal(v.broken_at, 1);
});

test('deleting an audit entry is detected', () => {
  const log = new AuditLog();
  log.append('a', { n: 1 });
  log.append('b', { n: 2 });
  log.append('c', { n: 3 });
  log.entries.splice(1, 1);
  assert.equal(log.verify().intact, false);
});
