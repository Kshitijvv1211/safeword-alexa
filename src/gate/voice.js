import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';

// Amazon Polly gives SafeWord's spoken replies a real neural voice (the "say" line of
// every decision). If Polly is unavailable the simulator falls back to browser speech.

export function createVoice({
  region = process.env.AWS_REGION || 'us-east-1',
  voiceId = process.env.POLLY_VOICE || 'Joanna',
  engine = process.env.POLLY_ENGINE || 'neural',
  enabled = process.env.USE_POLLY !== '0',
  client,
} = {}) {
  const polly = enabled ? client ?? new PollyClient({ region }) : null;
  const cache = new Map();
  let status = { ok: null, voice: `${voiceId} (${engine})` };

  async function synthesize(text) {
    if (!polly) throw Object.assign(new Error('Polly is turned off'), { name: 'Disabled' });
    const key = text.trim();
    if (cache.has(key)) return cache.get(key);
    const started = Date.now();
    try {
      const res = await polly.send(new SynthesizeSpeechCommand({ Text: key, OutputFormat: 'mp3', VoiceId: voiceId, Engine: engine }), { abortSignal: AbortSignal.timeout(12000) });
      const audio = Buffer.from(await res.AudioStream.transformToByteArray());
      status = { ok: true, voice: `${voiceId} (${engine})`, latency_ms: Date.now() - started };
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      cache.set(key, audio);
      return audio;
    } catch (err) {
      status = { ok: false, voice: `${voiceId} (${engine})`, error: err.name, message: err.message };
      throw err;
    }
  }

  return { synthesize, status: () => status, enabled: Boolean(polly) };
}
