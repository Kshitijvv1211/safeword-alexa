import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoice } from '../src/gate/voice.js';

const fakePolly = () => {
  const calls = [];
  return {
    calls,
    send: async (cmd) => {
      calls.push(cmd.input);
      return { AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    },
  };
};

test('Polly synthesizes with the configured neural voice and caches repeated lines', async () => {
  const client = fakePolly();
  const voice = createVoice({ enabled: true, client, voiceId: 'Joanna', engine: 'neural' });
  const a = await voice.synthesize('Done. I went ahead and ordered it.');
  await voice.synthesize('Done. I went ahead and ordered it.');
  assert.equal(a.length, 3);
  assert.equal(client.calls.length, 1, 'second call served from cache');
  assert.deepEqual([client.calls[0].VoiceId, client.calls[0].Engine, client.calls[0].OutputFormat], ['Joanna', 'neural', 'mp3']);
  assert.equal(voice.status().ok, true);
});

test('a Polly failure is reported so the simulator can fall back to browser speech', async () => {
  const voice = createVoice({ enabled: true, client: { send: async () => { throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' }); } } });
  await assert.rejects(voice.synthesize('hi'), /not authorized/);
  assert.equal(voice.status().error, 'AccessDeniedException');
  await assert.rejects(createVoice({ enabled: false }).synthesize('hi'), /turned off/);
});
