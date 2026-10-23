import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';

// Bedrock second opinion. After the deterministic rules allow a money or door action,
// a model reads what was actually said and may flag it as suspicious. It can only
// RAISE caution (allow -> confirm), never lower a verdict, and it is skipped entirely
// when Bedrock is off, slow or failing. Rules stay in charge.

const SYSTEM = [
  'You are a cautious safety reviewer for a family voice assistant.',
  'You see a request the household rules already allowed. Decide whether it still looks like fraud, coercion, an impersonation, or a child misusing an adult account.',
  'Only flag clear warning signs in the words or the situation. Ordinary shopping and paying known people is fine.',
  'Call the review tool exactly once.',
].join(' ');

const TOOL = {
  toolSpec: {
    name: 'review',
    description: 'Report whether the request needs a human to double-check it.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          suspicious: { type: 'boolean' },
          reason: { type: 'string', description: 'If suspicious: a short plain-English reason, under 15 words.' },
        },
        required: ['suspicious'],
      },
    },
  },
};

export function createAdvisor({
  enabled = process.env.USE_BEDROCK === '1' && process.env.BEDROCK_SECOND_OPINION !== '0',
  modelId = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0',
  region = process.env.AWS_REGION || 'us-east-1',
  timeoutMs = Number(process.env.BEDROCK_ADVISOR_TIMEOUT_MS || 2500),
  client,
} = {}) {
  const bedrock = enabled ? client ?? new BedrockRuntimeClient({ region }) : null;

  return async function advise(decision) {
    // Only an "allow" can be raised, so only those are worth a model call.
    if (!bedrock || decision.verdict !== 'allow' || !['purchase', 'transfer', 'unlock'].includes(decision.action.type)) return null;
    const started = Date.now();
    try {
      const res = await bedrock.send(new ConverseCommand({
        modelId,
        system: [{ text: SYSTEM }],
        messages: [{ role: 'user', content: [{ text: JSON.stringify({ said: decision.context.utterance, speaker_role: decision.context.speaker.role, action: decision.action }) }] }],
        toolConfig: { tools: [TOOL], toolChoice: { any: {} } },
        inferenceConfig: { maxTokens: 120, temperature: 0 },
      }), { abortSignal: AbortSignal.timeout(timeoutMs) });
      const out = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse?.input;
      if (!out) return null;
      return { raise: out.suspicious === true, reason: out.reason || 'it looks unusual', source: 'bedrock', model: modelId, latency_ms: Date.now() - started };
    } catch {
      return null;
    }
  };
}
