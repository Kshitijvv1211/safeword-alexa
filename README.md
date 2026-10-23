# SafeWord for Alexa+

**Alexa+ can now spend your money. SafeWord makes sure it's really you, and really safe.**

SafeWord is a two-sided trust layer for Alexa+, built as a self-hosted MCP server (Streamable HTTP, spec 2025-11-25). Its engine is called **Decision Gate**.

- **Protects the household (people).** Before Alexa+ buys, pays or unlocks, SafeWord checks the request against house rules, the household's own spending habits, and who is speaking. Risky requests need an adult, a guardian on another phone, or the family's spoken **safe word**, because voices can be cloned.
- **Protects the agent (add-ons).** Alexa+ routes requests across many brand add-ons. SafeWord pins each add-on's tool manifest with SHA-256, blocks it if it changes silently (a "rug pull"), scans tool text for hidden instructions, and filters prompt injections out of add-on replies.

```
Alexa+ ──MCP──▶ SafeWord (Decision Gate engine) ──MCP──▶ FreshCart  (groceries, trusted)
                 │ house rules + habits                  ──MCP──▶ Lockwise   (smart locks, trusted)
                 │ checkout guard (Idempotency-Key)      ──MCP──▶ QuickPay   (wallet, trusted)
                 │ safe word + guardian approval         ──MCP──▶ DealsBot   (untrusted, hostile demo add-on)
                 │ add-on pinning + injection filter
                 │ hash-chained audit log
                 └ Amazon Bedrock (explanations, rule drafting, raise-only second opinion)
```

How SafeWord fits:

1. As a **household guardian add-on** the customer enables. It is a gateway that other add-ons are reached through, or an advisor (`evaluate_action`, `evaluate_checkout`) that flows consult.
2. As **middleware in a brand's own checkout**, so the brand protects its customers and cuts refunds and support tickets.

We don't claim Alexa+ calls SafeWord automatically today. The official Alexa+ toolkit is partner-preview, so this repo includes a protocol-faithful Alexa+ simulator.

## Verdicts

Every gated call gets one verdict, with a risk score, plain-English reasons and a line for Alexa+ to say aloud:

| Verdict | What happens |
|---|---|
| **allow** | Forwarded to the brand right away. |
| **confirm** | Approved *inside the same tool call* through **MCP elicitation**: an adult's passcode, or the **family safe word** for big transfers to someone new. It can also be escalated to the **guardian's phone**. |
| **hold** | **Scam Shield**: grandparent-scam, fake-official, secrecy, and gift-card or crypto patterns. Only the guardian can release it. |
| **block** | Never reaches the brand. |

## Features

**Household side**
- **House rules:** auto-approve limits, blocked categories, quiet hours, child purchases, who can unlock doors, and a speed check (the 6th money action from one voice within 10 minutes needs approval).
- **Household baseline (stateful):** for example "$479.99 is 7.7x what you usually spend on electronics", or "a store this household has never used". It learns from approved purchases.
- **Checkout guard** (`evaluate_checkout`) for Alexa+-style checkout sessions, following the [checkout docs](https://developer.amazon.com/docs/alexaplus/add-ons/implement-checkout-endpoints.html):
  - Same `Idempotency-Key` with the same body returns the original decision. Nothing is re-run and nothing is charged twice.
  - Same key with a different body is rejected (`idempotency_conflict`).
  - **Price drift**: a total that rose more than 10% between Create and Complete needs approval, and more than 30% is blocked.
  - **Duplicate order**: the same items from the same merchant completed within 10 minutes needs approval.
- **Family safe word:** a big transfer to someone new (from $100 by default) asks a question the family set ("What is the name of Grandpa's first dog?"). Only a hash of the answer is stored. Two wrong answers lock the request and alert every adult. A passcode can't skip it.
- **Guardian approval:** `request_guardian_approval` sends any pending request to the guardian's phone, and `guardian_decide` lets the guardian approve or **deny** it.
- **Scam Shield:** scam-language detection plus a new payee plus speaker role puts the money on a caregiver-only hold.
- **Plain-English rules with Amazon Bedrock:** "lower the auto-approve limit to $20 and block video games" becomes a validated policy patch, with a dry-run against real past decisions. An adult must apply it.
- **Policy dry-run:** shows which recent decisions would flip under a proposed rule.

**Agent side**
- **Add-on integrity guard:**
  - On first use, each add-on's manifest (names, descriptions, schemas, annotations) is pinned with SHA-256.
  - **Every forwarded call re-checks it.** A silent change blocks the add-on, shows pinned and current hashes, and alerts the guardian.
  - `pin_addon` re-approves a reviewed change, and is refused if the text is poisoned.
- **Tool-text scanner** (`scan_tool_text`) checks for override phrases, "do not tell the user", cross-tool calls, fake `<IMPORTANT>` tags, credential grabs, invisible Unicode, base64 blobs and URLs.
- **Injection filter on replies:** instruction-like sentences in add-on output are removed before Alexa+ reads them.
- **Annotations are hints, not trust:** read-only hints relax checks only for trusted add-ons. On untrusted add-ons, a "read-only" tool whose description says it charges you is blocked.
- The integrity code is also published as a standalone MIT package, **[`mcp-manifest-guard`](https://github.com/Kshitijvv1211/mcp-manifest-guard)**, with a library, a CLI and tests.

**Platform**
- **MCP elicitation** for in-call approvals (passcode form or safe-word question).
- **MCP App approval card:** `ui://decision-gate/decision-card` (`text/html;profile=mcp-app`) shows the verdict, risk bar and reasons, plus an approve form or safe-word form. The plain-text result still works on voice-only devices.
- **Agent Skill:** [`skills/decision-gate/SKILL.md`](skills/decision-gate/SKILL.md).
- **Tamper-evident audit:** a SHA-256 hash chain, with a "Tamper with log" demo button.
- **Deterministic and fast:** rules decide in about 1–5 ms (shown on every decision). No model can lower a verdict.
- **Streamable HTTP security:** Origin 403, unknown session 404 with client re-init, an optional bearer token, and DELETE on close.
- **Accessible simulator:** labelled controls, keyboard focus rings, a skip link, live regions, reduced-motion support, and voice in and out.

## Run it

Requires Node 22.9+ (reads `.env` automatically if present).

```bash
npm install
npm test
npm run dev
```

Open http://127.0.0.1:8787 for the simulator. The MCP endpoint is `http://127.0.0.1:8787/mcp`. `npm run demo:reset` wipes local demo data. Restarting the server also restores the DealsBot add-on after a rug-pull demo.

Demo test values (in `src/gate/policy.js`): passcodes **Sam 4321** and **Alex 2468** (Alex is the guardian). The safe word is **Biscuit**.

### Amazon Polly (live voice)

Every spoken reply (the decision's `say` line) is synthesized by **Amazon Polly** with the neural voice Joanna (`src/gate/voice.js`, endpoint `POST /tts`), so the simulator sounds like a real assistant. It turns on automatically when AWS credentials are present; the IAM user needs `AmazonPollyReadOnlyAccess`. The voice label under the input shows "Amazon Polly · Joanna (neural)". If Polly can't answer, browser speech covers that line. Settings: `POLLY_VOICE`, `POLLY_ENGINE`, and `USE_POLLY=0` to turn it off.

### Amazon Bedrock

Bedrock is used in three places, all through the Converse API (`@aws-sdk/client-bedrock-runtime`), and none of them can lower a verdict:

1. `src/gate/explain.js` turns each decision into one calm spoken sentence.
2. `src/gate/proposer.js` drafts plain-English rule changes with **Converse tool-use**. The draft is validated by zod and applied only by an adult.
3. `src/gate/advisor.js` gives a **raise-only second opinion**: after the rules allow a money or door action, the model may flag it (allow becomes confirm), never the other way.

Setup, with the same commands in PowerShell, cmd and bash:

1. Create an IAM user with an access key and the `AmazonBedrockLimitedAccess` policy. Amazon Nova models are enabled automatically on first use; there is no model-access step.
2. Put `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in `.env` (copy `.env.example`). Leave them empty if you use `aws configure` or `AWS_PROFILE`.
3. Run the check, then start with Bedrock on:

```bash
npm run bedrock:check
```

```bash
npm run dev:bedrock
```

If Bedrock is off, slow or failing, everything falls back to deterministic code, and the error name is reported.

### Connect another MCP client

```bash
npx @modelcontextprotocol/inspector
```

Choose "Streamable HTTP" and `http://127.0.0.1:8787/mcp`. Claude Code picks the server up from [`.mcp.json`](.mcp.json).

### Security settings

| Variable | Effect |
|---|---|
| `ALLOWED_ORIGINS` | Extra browser origins allowed; others get 403 |
| `MCP_AUTH_TOKEN` | Require `Authorization: Bearer <token>` (401 otherwise). Open the simulator as `/#token=<token>`. This is a stand-in for MCP OAuth 2.1. |
| `DEMO_MODE=0` | Disable `/demo/tamper` and `/demo/rug-pull` |

## MCP tools (27)

| Tool | Purpose |
|---|---|
| `evaluate_action` | Verdict for any action, without executing it |
| `evaluate_checkout` | Checkout-session check: idempotent replay or conflict, price drift, duplicates, plus house rules |
| `confirm_action` | Adult approves a pending request (single use, expires, 3 tries) |
| `answer_challenge` | Answer the family safe-word question (2 tries, then locked and the family is alerted) |
| `request_guardian_approval` / `guardian_decide` | Escalate to the guardian's phone; the guardian approves or denies |
| `set_safe_word_challenge` | Set the safe-word question and answer (adult, answer hashed) |
| `get_policy` / `simulate_policy` / `propose_policy_change` / `update_policy` | House rules, dry-run, plain-English drafting (Bedrock), apply (adult) |
| `verify_addon` / `pin_addon` / `scan_tool_text` | Add-on integrity: compare with the pin, re-approve, scan for poisoning |
| `get_audit_log` | Hash-chain status, impact numbers, add-on status, pending approvals, guardian alerts |
| `<addon>__<tool>` (12) | The brand add-ons' tools, proxied through SafeWord. They are gated, passed through, or quarantined, and every call is integrity-checked first. |

Each proxied tool takes an extra `alexa_context` input with the signals Alexa+ already has:

```json
{ "speaker": { "id": "alex", "role": "adult" }, "utterance": "Order the 27-inch 4K monitor", "local_time": "23:05", "home_occupied": true }
```

## Simulator

- A hand-written Streamable HTTP client (`public/mcp-client.js`) with live JSON-RPC traffic. It handles `elicitation/create` mid-call.
- A minimal MCP Apps host. It renders the `ui://` card in a sandboxed iframe and proxies the card's `tools/call`. A production web host would add the spec's separate-origin sandbox proxy.
- Scenario buttons cover groceries, the 11 pm monitor, the child, the 2 am stranger, the grandparent scam, the cloned voice ($900, safe word), the rogue store, the add-on rug pull, the three checkout cases (price jump, retried payment, duplicate), and plain-English rules.
- Real Alexa+ chooses tools with an LLM. Here a small phrase matcher does that, so the demo is repeatable.

## Project layout

```
src/
  server.js                 Express + Streamable HTTP, Origin/auth checks, demo routes
  mcp/server.js             MCP tools + ui:// resource, elicitation, gateway routing
  mcp/ui/decision-card.html MCP App approval card
  gateway/gateway.js        MCP client to each add-on, classification, integrity verify/pin
  gateway/manifest-guard.js Manifest pinning + tool-text scanner (also published as mcp-manifest-guard)
  gateway/sanitize.js       Injection filter for add-on replies
  downstream/brands.js      FreshCart, Lockwise, QuickPay, and the hostile DealsBot
  gate/engine.js            Deterministic decision engine (pure)
  gate/gate.js              Confirmations, safe word, guardian, holds, history, audit, impact
  gate/checkout.js          Checkout guard (idempotency, drift, duplicates)
  gate/scam.js              Scam Shield patterns
  gate/policy.js            Policy schema, defaults, scrypt hashing
  gate/audit.js             Hash-chained audit log
  gate/explain.js           Bedrock explanations
  gate/proposer.js          Bedrock rule drafting (tool-use) + offline phrase rules
  gate/advisor.js           Bedrock raise-only second opinion
scripts/bedrock-check.js    One-shot Bedrock setup check
public/                     Alexa+ simulator + MCP Apps host
skills/decision-gate/       Agent Skill
test/                       61 node:test tests, including end-to-end MCP over HTTP
```

## Tests

`npm test` runs **61 tests**. They cover:

- MCP protocol `2025-11-25` over real HTTP
- elicitation approvals and the safe word
- guardian approve and deny
- the checkout guard (replay, conflict, drift, duplicate)
- rug-pull detection and refused re-approval
- the tool-text scanner and the injection filter
- the Bedrock features, with mocked clients
- Origin 403, session 404 and auth 401
- the MCP Apps resource
- the audit chain

## Limits

- Speaker identity and presence come from `alexa_context`. In production they would come from Alexa+ voice ID and device signals.
- Passcodes and the safe word stand in for stronger factors, such as a push approval in the Alexa app.
- Manifest pins and checkout keys are kept in memory; production would use DynamoDB with 24-hour key retention, as the checkout docs require.
- Scam and injection detection are deterministic heuristics: explainable, but not exhaustive.

## License

MIT, see [LICENSE](LICENSE).
