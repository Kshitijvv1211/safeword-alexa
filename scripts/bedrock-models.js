// Find a Bedrock model this AWS account can actually run.
// Sends one tiny Converse call (a few tokens, a fraction of a cent) to each of the
// cheapest serverless models, with and without tool use, and prints which work.
//   npm run bedrock:models
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { hasAwsCredentials } from '../src/server.js';

const region = process.env.AWS_REGION || 'us-east-1';

// Cheapest first. "us." ids are cross-region inference profiles; plain ids run in this region only.
const CANDIDATES = [
  'amazon.nova-micro-v1:0',
  'us.amazon.nova-micro-v1:0',
  'amazon.nova-lite-v1:0',
  'us.amazon.nova-lite-v1:0',
  'apac.amazon.nova-micro-v1:0',
  'apac.amazon.nova-lite-v1:0',
  'us.amazon.nova-2-lite-v1:0',
  'global.amazon.nova-2-lite-v1:0',
  'us.meta.llama3-1-8b-instruct-v1:0',
  'meta.llama3-8b-instruct-v1:0',
  'mistral.mistral-7b-instruct-v0:2',
  'us.amazon.nova-pro-v1:0',
];

const TOOL = {
  tools: [{ toolSpec: { name: 'ok', description: 'Say ok.', inputSchema: { json: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } } }],
  toolChoice: { any: {} },
};

if (!hasAwsCredentials()) {
  console.log('No AWS credentials found. Put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env first.');
  process.exit(1);
}

const client = new BedrockRuntimeClient({ region });
const call = async (modelId, withTool) => {
  const started = Date.now();
  try {
    await client.send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: withTool ? 'Call the ok tool.' : 'Reply with the word OK.' }] }],
      inferenceConfig: { maxTokens: 20, temperature: 0 },
      ...(withTool && { toolConfig: TOOL }),
    }), { abortSignal: AbortSignal.timeout(10000) });
    return { ok: true, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, why: `${err.name}: ${err.message}`.slice(0, 110) };
  }
};

console.log(`Scanning Bedrock models in ${region}…\n`);
const working = [];
for (const id of CANDIDATES) {
  const text = await call(id, false);
  if (!text.ok) {
    console.log(`✗ ${id.padEnd(36)} ${text.why}`);
    continue;
  }
  const tool = await call(id, true);
  console.log(`✓ ${id.padEnd(36)} text ok (${text.ms} ms) · tool use ${tool.ok ? 'ok' : 'not supported'}`);
  working.push({ id, tool: tool.ok });
}

const best = working.find((w) => w.tool) ?? working[0];
console.log('');
if (!best) {
  console.log('No model worked. If every line says "Operation not allowed", Bedrock is blocked for the whole account.');
  console.log('New accounts get this until AWS finishes verifying them (try AWS_REGION=us-east-2 to see that message). Otherwise:');
  console.log('upgrade from the Free plan (Billing > account plan), make sure the card is verified, or open a free');
  console.log('"Account and billing" support case asking AWS to enable Amazon Bedrock.');
  process.exit(1);
}
console.log(`Use this one. Put it in .env:\n\n  BEDROCK_MODEL_ID=${best.id}\n`);
if (!best.tool) console.log('(It has no tool use, so plain-English rules and the second opinion fall back to local rules.)');
console.log('Then run: npm run bedrock:check');
