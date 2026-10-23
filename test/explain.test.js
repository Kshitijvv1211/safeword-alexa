import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExplainer } from '../src/gate/explain.js';

const decision = {
  verdict: 'confirm',
  say: 'I need an adult to approve it first.',
  reasons: ['$480 is over the $50 auto-approve limit'],
  action: { type: 'purchase', description: 'Order monitor' },
  context: { speaker: { role: 'adult' } },
};

test('uses the template line when Bedrock is off', async () => {
  const r = await createExplainer({ enabled: false })(decision);
  assert.deepEqual(r, { text: decision.say, source: 'template' });
});

test('calls Bedrock Converse and returns its sentence', async () => {
  let sent;
  const client = { send: async (cmd) => { sent = cmd.input; return { output: { message: { content: [{ text: 'That monitor costs more than your usual limit, so an adult needs to okay it.' }] } } }; } };
  const r = await createExplainer({ enabled: true, client, modelId: 'test-model' })(decision);
  assert.equal(r.source, 'bedrock');
  assert.equal(sent.modelId, 'test-model');
  assert.match(sent.messages[0].content[0].text, /"verdict":"confirm"/);
});

test('falls back to the template when Bedrock fails', async () => {
  const client = { send: async () => { throw Object.assign(new Error('no access'), { name: 'AccessDeniedException' }); } };
  const r = await createExplainer({ enabled: true, client })(decision);
  assert.equal(r.source, 'template');
  assert.equal(r.bedrock_error, 'AccessDeniedException');
});
