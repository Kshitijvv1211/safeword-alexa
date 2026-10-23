// One-shot check that Amazon Bedrock is reachable with your credentials and model.
// Runs both Bedrock features (spoken explanation + plain-English rule drafting) once
// and prints what to fix if something fails.
//   npm run bedrock:check
import { createExplainer } from '../src/gate/explain.js';
import { createProposer } from '../src/gate/proposer.js';
import { createAdvisor } from '../src/gate/advisor.js';
import { createVoice } from '../src/gate/voice.js';
import { defaultPolicy } from '../src/gate/policy.js';
import { hasAwsCredentials } from '../src/server.js';

const modelId = process.env.BEDROCK_MODEL_ID || 'us.amazon.nova-lite-v1:0';
const region = process.env.AWS_REGION || 'us-east-1';

const HINTS = {
  CredentialsProviderError: 'No AWS credentials found. Put AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env (copy .env.example).',
  UnrecognizedClientException: 'The access key is not valid. Check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env.',
  InvalidSignatureException: 'The secret key does not match the access key. Re-copy AWS_SECRET_ACCESS_KEY.',
  ExpiredTokenException: 'Temporary credentials expired. Refresh them (or remove AWS_SESSION_TOKEN if using long-term keys).',
  AccessDeniedException: `AWS refused the call; the "AWS says" line above has the exact reason. "not authorized to perform: bedrock:InvokeModel" means the IAM user is missing the AmazonBedrockLimitedAccess policy. Messages about the account or payment mean AWS hasn't finished activating your account yet. Quick test: open Nova Lite in the Bedrock playground (${region}) as the root user; if that also fails, it's the account, not the keys.`,
  ResourceNotFoundException: `Model ${modelId} isn't available in ${region}. Use region us-east-1 or set BEDROCK_MODEL_ID to a model you have.`,
  ValidationException: `Bedrock rejected the request. Check BEDROCK_MODEL_ID (${modelId}); inference-profile ids start with "us." in US regions.`,
  ThrottlingException: 'Throttled by Bedrock. Wait a few seconds and run the check again.',
  TimeoutError: 'Bedrock did not answer in time. Check your network, or raise BEDROCK_TIMEOUT_MS in .env.',
};

console.log(`Bedrock check: model ${modelId}, region ${region}`);
if (!hasAwsCredentials()) {
  console.log(`✗ ${HINTS.CredentialsProviderError}`);
  process.exit(1);
}

let failed = false;
const report = (label, r, describe) => {
  if (r.source === 'bedrock') {
    console.log(`✓ ${label} via Bedrock in ${r.latency_ms} ms: ${describe(r)}`);
  } else {
    failed = true;
    console.log(`✗ ${label} fell back to local rules (${r.bedrock_error ?? 'unknown error'})`);
    if (r.bedrock_message) console.log(`  AWS says: ${r.bedrock_message}`);
    const hint = /operation not allowed/i.test(r.bedrock_message ?? '')
      ? 'Your AWS account is not allowed to run Bedrock yet. This is an account restriction, not your keys or code. Try BEDROCK_MODEL_ID=amazon.nova-lite-v1:0 in .env (skips cross-region routing). If that fails too: check that the account is on a paid plan (Billing > account plan, "Upgrade" if it says Free plan) and that the card is verified, or open a free Account and billing support case asking to enable Amazon Bedrock.'
      : HINTS[r.bedrock_error] ?? 'See the error name above and the Bedrock section of the README.';
    console.log(`  ${hint}`);
  }
};

const explain = createExplainer({ enabled: true });
report('Explanation', await explain({
  verdict: 'confirm',
  say: 'I need an adult to approve it first.',
  reasons: ['$479.99 is over the $50 auto-approve limit', 'PixelDeals Marketplace is a store this household has never used'],
  action: { type: 'purchase', description: 'Order 27-inch 4K monitor' },
  context: { speaker: { role: 'adult' } },
}), (r) => `"${r.text}"`);

const propose = createProposer({ enabled: true });
report('Rule drafting (tool use)', await propose('lower the auto-approve limit to $20 and block video games', defaultPolicy()), (r) => JSON.stringify(r.changes));

const advise = createAdvisor({ enabled: true, timeoutMs: 8000 });
const opinion = await advise({
  verdict: 'allow',
  action: { type: 'transfer', amount: 20, payee: 'Sam Rivera', description: 'Send $20 to Sam Rivera' },
  context: { utterance: 'Send $20 to Sam for pizza', speaker: { role: 'adult' } },
});
if (opinion) console.log(`✓ Second opinion via Bedrock in ${opinion.latency_ms} ms: ${opinion.raise ? `flagged (${opinion.reason})` : 'looks fine'}`);
else { failed = true; console.log('✗ Second opinion returned nothing (see the errors above).'); }

try {
  const voice = createVoice({ enabled: true });
  const t = Date.now();
  const audio = await voice.synthesize('Hello from SafeWord.');
  console.log(`✓ Amazon Polly voice ${voice.status().voice}: ${audio.length} bytes in ${Date.now() - t} ms`);
} catch (err) {
  console.log(`✗ Amazon Polly failed (${err.name})`);
  console.log(`  AWS says: ${err.message}`);
  if (err.name === 'AccessDeniedException') console.log('  Attach the AmazonPollyReadOnlyAccess policy to your IAM user, wait a minute, run again.');
}

console.log(failed ? '\nBedrock is not available yet (see above). Polly works on its own; start the demo with: npm run dev' : '\nAll good. Start the demo with: npm run dev:bedrock');
process.exit(failed ? 1 : 0);
