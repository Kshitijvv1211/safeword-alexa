import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, inQuietHours } from '../src/gate/engine.js';
import { defaultPolicy } from '../src/gate/policy.js';
import { seedHistory } from '../src/gate/seed.js';
import { scanForScam } from '../src/gate/scam.js';

const policy = defaultPolicy();
const history = seedHistory();
const adult = (time = '18:00') => ({ speaker: { id: 'alex', role: 'adult' }, local_time: time, home_occupied: true });

test('usual groceries from a known store are allowed', () => {
  const d = evaluate({ type: 'purchase', amount: 43.5, merchant: 'FreshCart', category: 'groceries', item: 'usual groceries' }, adult(), policy, history);
  assert.equal(d.verdict, 'allow');
  assert.ok(d.risk_score < 40);
});

test('a $480 monitor from a new store at 11pm needs confirmation with several reasons', () => {
  const d = evaluate({ type: 'purchase', amount: 479.99, merchant: 'PixelDeals Marketplace', category: 'electronics', item: '27-inch 4K monitor' }, adult('23:05'), policy, history);
  assert.equal(d.verdict, 'confirm');
  assert.ok(d.reasons.length >= 3, d.reasons.join(' | '));
  assert.ok(d.reasons.some((r) => r.includes('never used')));
  assert.ok(d.reasons.some((r) => r.includes('quiet hours')));
  assert.ok(d.reasons.some((r) => /x what you usually spend/.test(r)));
});

test('children cannot order', () => {
  const d = evaluate({ type: 'purchase', amount: 50.97, merchant: 'FreshCart', category: 'digital_games', quantity: 3 }, { speaker: { id: 'mia', role: 'child' }, local_time: '16:00' }, policy, history);
  assert.equal(d.verdict, 'block');
  assert.ok(d.risk_score >= 90);
});

test('blocked categories are blocked even for adults', () => {
  const d = evaluate({ type: 'purchase', amount: 100, merchant: 'FreshCart', category: 'gift_cards' }, adult(), policy, history);
  assert.equal(d.verdict, 'block');
});

test('unknown voice unlocking at 2am with nobody home is blocked', () => {
  const d = evaluate({ type: 'unlock', door: 'front door' }, { speaker: { role: 'unknown' }, local_time: '02:00', home_occupied: false }, policy, history);
  assert.equal(d.verdict, 'block');
});

test('a recognised adult unlocking in the day is allowed', () => {
  const d = evaluate({ type: 'unlock', door: 'front door' }, adult('14:00'), policy, history);
  assert.equal(d.verdict, 'allow');
});

test('grandparent-scam transfer is put on hold for the caregiver', () => {
  const d = evaluate(
    { type: 'transfer', amount: 900, payee: 'Jake Miller' },
    { speaker: { id: 'grandpa', role: 'elder' }, utterance: "Send 900 dollars to Jake Miller, it's urgent, he needs bail money, don't tell anyone", local_time: '15:00' },
    policy, history,
  );
  assert.equal(d.verdict, 'hold');
  assert.ok(d.scam.hits.map((h) => h.id).includes('secrecy'));
});

test('paying a known payee a small amount is allowed', () => {
  const d = evaluate({ type: 'transfer', amount: 20, payee: 'Sam Rivera' }, adult(), policy, history);
  assert.equal(d.verdict, 'allow');
});

test('tools with no household rule default to confirm', () => {
  const d = evaluate({ type: 'other', tool: 'acme__delete_account' }, adult(), policy, history);
  assert.equal(d.verdict, 'confirm');
});

test('the same input always gives the same verdict', () => {
  const a = { type: 'purchase', amount: 479.99, merchant: 'PixelDeals Marketplace', category: 'electronics' };
  const runs = new Set(Array.from({ length: 20 }, () => JSON.stringify(evaluate(a, adult('23:00'), policy, history).factors)));
  assert.equal(runs.size, 1);
});

test('quiet hours wrap past midnight', () => {
  assert.equal(inQuietHours('23:30', policy.quiet_hours), true);
  assert.equal(inQuietHours('06:59', policy.quiet_hours), true);
  assert.equal(inQuietHours('07:00', policy.quiet_hours), false);
});

test('scam scanner ignores normal requests', () => {
  assert.equal(scanForScam('send twenty dollars to Sam for dinner').score, 0);
});
