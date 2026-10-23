import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Amazon Bedrock turns the engine's reasons into one calm spoken sentence.
// It only rephrases a verdict that has already been decided; if Bedrock is off,
// slow or failing, the deterministic template line is used instead.

const SYSTEM = [
  'You write one short sentence that a voice assistant will say aloud to a family member.',
  'You are given a decision that has ALREADY been made and the reasons for it.',
  'Never change, soften or argue with the decision. Never suggest a way around it.',
  'Be warm and plain. No more than 30 words. No lists, no markdown, no emojis.',
].join(' ');

export function createExplainer({
  enabled = process.env.USE_BEDROCK === '1',
  modelId = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0',
  region = process.env.AWS_REGION || 'us-east-1',
  timeoutMs = Number(process.env.BEDROCK_TIMEOUT_MS || 4000),
  client,
} = {}) {
  const bedrock = enabled ? client ?? new BedrockRuntimeClient({ region }) : null;

  return async function explain(decision) {
    const fallback = { text: decision.say, source: 'template' };
    if (!bedrock) return fallback;
    const prompt = JSON.stringify({
      verdict: decision.verdict,
      action: decision.action.description || decision.action.type,
      reasons: decision.reasons,
      speaker_role: decision.context.speaker.role,
    });
    const started = Date.now();
    try {
      const res = await bedrock.send(new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 80, temperature: 0.2 },
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      const text = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim();
      if (!text) return fallback;
      return { text, source: 'bedrock', model: modelId, latency_ms: Date.now() - started };
    } catch (err) {
      return { ...fallback, bedrock_error: err.name || 'Error', bedrock_message: err.message };
    }
  };
}
