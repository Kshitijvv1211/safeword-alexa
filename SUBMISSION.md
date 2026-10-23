# Devpost submission kit: SafeWord (not part of the app)

Deadline: **Oct 23, 12:00 pm PDT = Oct 24, 12:30 am IST.** Aim to submit by 12:00 am IST.

## Tracks
- **Primary track: Alexa+.** It is a self-hosted MCP server (spec 2025-11-25, Streamable HTTP) plus a simulated Alexa+ client with full source. It hits the judges' "creative" list: stateful add-on, purchasing, MCP Apps, Agent Skill, cross-person workflow.
- **AWS Builder:** **Amazon Polly is live.** Every spoken reply uses the Polly neural voice (`src/gate/voice.js`); show the "Amazon Polly · Joanna (neural)" label in the video. Amazon Bedrock Converse is also fully integrated in three documented places (explanations, tool-use rule drafting, raise-only second opinion) and tested with mocks. On our new AWS account Bedrock still returned "Operation not allowed" pending account verification, so say exactly that.
- **Open Source:** the separate MIT package `mcp-manifest-guard` (fields below). You can win at most one mini challenge, but entering both raises your odds.

## Name and tagline
**SafeWord**: Alexa+ can now spend your money. SafeWord makes sure it's really you, and really safe.

## Text description (paste into Devpost)
Alexa+ is moving from answering questions to taking actions: ordering, paying, unlocking. Brands now plug their own MCP add-ons into it, and checkout happens in the conversation. That creates two new risks. People can be scammed through their own assistant, by a cloned voice, a pressured grandparent, or a price that jumps at payment. And the assistant itself can be attacked by an add-on whose tool descriptions hide instructions or change after they were approved.

SafeWord is a two-sided trust layer for Alexa+, built as a self-hosted MCP server (Streamable HTTP, spec 2025-11-25). Its engine is called Decision Gate.

**Protecting the household.** Before Alexa+ buys, pays or unlocks, SafeWord checks the request against house rules, the household's own habits ("this is 7.7x what you usually spend on electronics", "a store you've never used"), who is speaking, and the time of day. The answer is allow, confirm, hold or block, with a risk score, reasons and a sentence for Alexa+ to say.
- Confirmations happen inside the same tool call through MCP elicitation.
- A big transfer to someone new needs the family's spoken **safe word**, because a voice can be cloned. Two wrong answers lock it and alert the family.
- Any request can be sent to a **guardian's phone** to approve or deny.
- Scam Shield detects grandparent-scam and fake-official patterns and puts the money on a hold only the guardian can release.
- A **checkout guard** follows the Alexa+ checkout contract: a retried payment with the same Idempotency-Key returns the original decision and never charges twice, and a reused key with a different body is rejected. It also holds a total that jumps between Create and Complete, and catches duplicate orders.

**Protecting the agent.** SafeWord sits between Alexa+ and brand add-ons as an MCP gateway.
- It pins every add-on's tool manifest with SHA-256 and re-checks it before every call. If an add-on silently rewrites a tool description after approval (a "rug pull"), the add-on is blocked, the guardian is alerted, and the pinned and new hashes are shown.
- It scans tool text for hidden instructions: "ignore previous instructions", "do not tell the user", "also call…", fake tags, invisible Unicode, and encoded blobs.
- It removes prompt injections from add-on replies before Alexa+ reads them.
- It blocks an untrusted add-on that labels a card-charging tool as "read-only".

The decision is deterministic code, about 1–5 ms per decision, so no prompt can talk it past a limit. Amazon Bedrock adds three things that can never lower a verdict:
- a calm spoken explanation;
- plain-English rule changes, using Converse tool-use, validated by schema, dry-run against past decisions, and applied only by an adult;
- a raise-only second opinion on requests the rules allowed.

Every decision, approval, rule change and integrity alert lands in a hash-chained audit log, and the demo shows tampering being detected.

Other pieces:
- An **MCP App** approval card (`ui://` resource) renders the verdict, risk bar and an approve or safe-word form in any MCP Apps host.
- An **Agent Skill** teaches any agent how to use SafeWord.
- The integrity guard is published separately as the open-source package `mcp-manifest-guard`.

Because the Alexa+ MCP Toolkit and simulator are partner-preview only, we built a protocol-faithful Alexa+ simulator. It does the real initialize, tools/list, tools/call, elicitation and MCP Apps exchanges, shows every JSON-RPC message, and supports voice in and out.

For families this means an assistant that respects house rules and protects the people scammers target. For brands it means fewer wrong and duplicate orders, refunds, chargebacks and support tickets.

## Built with
Node.js, @modelcontextprotocol/sdk (Streamable HTTP, protocol 2025-11-25, elicitation), MCP Apps extension (2026-01-26), Agent Skills, Amazon Polly (neural TTS), Amazon Bedrock Runtime (Converse API + tool use; integrated, pending account verification), Express, Zod, Web Speech API, node:test.

## Why now (reported figures; cite carefully)
- Amazon adopted MCP for Alexa+ and lets brands bring their own servers. Launch partners named include Bosch, Whirlpool, iRobot, Yale and Eufy (Forkast, Aug 2026).
- Alexa+ checkout defines sessions, Idempotency-Keys, totals and a retry-safe Complete step (Alexa+ checkout docs).
- Tool poisoning and rug pulls are documented MCP attacks (Cloud Security Alliance research note).
- Voice-clone scam figures circulate mainly from vendor pages. Say "reported", or cite FTC or FBI originals.

## Pre-existing work statement
Everything in this repository and in `mcp-manifest-guard` was built during the submission window. The decision-gate concept predates it; no earlier code is included.

## Demo video script (2:50; run `npm run demo:reset`, then `npm run dev:bedrock`, in Chrome)
1. **0:00–0:15 Hook.** "Alexa+ can now buy, unlock and pay. Who checks first?" Show the SafeWord header and "2025-11-25 · 27 tools".
2. **0:15–0:45 Household.** *Usual groceries* → allow. *$480 monitor at 11pm* → the elicitation approval pops up mid-call. Show the reasons (7.7x usual, new store, quiet hours) and the MCP App card. Approve.
3. **0:45–1:15 Cloned voice.** *Cloned voice: $900* → "Before I send $900 to Mark Davis, I need the family safe word". Type a wrong answer twice → locked, and the guardian phone lights up.
4. **1:15–1:50 Hero: rug pull.** *Rogue store: find deals* (injection removed). Then *Add-on rug pull* → **BLOCK**, with pinned vs current hash and findings (invisible text, fake tag, "do not tell the user"). Open the **Add-ons** tab: DealsBot "changed"; Re-approve is refused.
5. **1:50–2:15 Checkout guard.** *Checkout: price jumps* → "+18% between checkout and payment" → held. *Checkout: retried payment* → "nothing charged twice", then the key-reuse conflict is blocked.
6. **2:15–2:35 Trust.** *Grandparent scam* → hold → guardian approves or denies. Audit tab: chain intact → *Tamper with log* → broken. Point at the latency ("~2 ms rules") and `explanation: bedrock`.
7. **2:35–2:50 Close.** "Two-sided protection: people from scams, Alexa+ from rogue add-ons. Fewer wrong orders and refunds for brands, safer homes for families."

## Open Source mini challenge fields
- **Contribution:** a new open-source project, `mcp-manifest-guard` (MIT, zero dependencies, 6 tests, library + CLI).
- **Contribution URL:** `https://github.com/<your-username>/mcp-manifest-guard` (fill in after pushing)
- **Main repo URL:** `https://github.com/<your-username>/<safeword-repo>`
- **GitHub username:** Kshitijvv1211
- **What / how / why:** It pins an MCP server's tool manifest with SHA-256 (canonical, order-independent), reports exactly which tools changed, were added or were removed, and scans tool names, descriptions and nested schemas for poisoning patterns (instruction overrides, "do not tell the user", cross-tool calls, fake tags, credential grabs, invisible Unicode, base64 blobs, URLs). The CLI (`pin` / `verify` / `scan`) exits non-zero on problems, so it can gate CI. It matters because MCP clients trust tool text, and tool poisoning and rug pulls are documented attacks; this gives any client or gateway a cheap, deterministic defense. SafeWord uses the same code to check every add-on call.

## Product feedback (edit with your real experience)
- **Alexa+ MCP Toolkit / simulator:** partner-preview only, so a public developer can't test against real Alexa+. We used the simulated path. Suggestions: a public sandbox; document which client capabilities Alexa+ declares (elicitation, MCP Apps); and document how voice ID and household context reach an MCP server.
- **Alexa+ checkout docs:** clear on idempotency (replay on same key and body, 409 on a different body), and we mirrored it. Add how an MCP add-on's purchase flow hands off to checkout end to end.
- **MCP TypeScript SDK 1.32.1:** solid. Two gotchas:
  - `createMcpExpressApp` validates Host but not Origin, which the spec requires, so we added it.
  - For elicitation on the same SSE stream as a tool call, use `extra.sendRequest`, not `server.elicitInput`.
- **MCP Apps:** the spec was clear; we hand-rolled a minimal host for the simulator.
- **Amazon Bedrock:** Converse plus tool use for structured rule drafting and a raise-only reviewer, with Nova Lite. Add your real latency from `npm run bedrock:check`, and how model access felt.

## Feature requests
| Request | Why | Urgency |
|---|---|---|
| Pass verified speaker identity to MCP servers (request `_meta`) | Household-aware add-ons need a trusted "who is speaking" | Critical |
| Notify add-ons of the manifest pin Alexa+ approved, and re-prompt on change | Platform-level rug-pull protection | Important |
| Public Alexa+ MCP sandbox | Non-partners can validate end to end | Important |

## Friction log (keep only entries you confirm)
| Task | Steps | Expected | Actual | Severity | Workaround | Suggestion |
|---|---|---|---|---|---|---|
| Test against real Alexa+ | Read the MCP Toolkit pages | Public way to connect | Toolkit, CLI and simulator are partner-preview | High | Protocol-faithful simulator | Public sandbox |
| Secure the Streamable HTTP endpoint | Used `createMcpExpressApp` | Spec-required Origin check | Host only; a foreign Origin got 200 | Medium | Own Origin middleware (403) | Validate Origin in the helper |
| Mid-call approval via elicitation | `server.elicitInput()` in a tool handler | Arrives on the tool call's stream | Goes to the standalone GET stream | Medium | `extra.sendRequest(...)` | Document it |
| Use Amazon Bedrock on a new account | Created an IAM user with AmazonBedrockLimitedAccess, called Converse with Nova Micro/Lite/Pro and Llama in several regions, upgraded to a paid plan | Model runs (model access is automatic now) | AccessDenied first, then "Operation not allowed" everywhere; only us-east-2 said "account is currently being verified" | High | Shipped Amazon Polly live; Bedrock code ready behind a flag | Return the verification reason in every region, and show verification status on the Bedrock console |
| Get AWS credits | Credit request | Credits | Out of codes since Oct 7 | Low | Free tier | Note it on the overview page |
| Understand payments flow | Read the payments overview | Transaction flow explained | Overview doesn't explain the flow; details are in the checkout pages | Low | Used the checkout endpoint docs | Add a sequence diagram |

## Checklist
- [ ] Put AWS keys in `.env` → `npm run bedrock:check` shows ✓ (otherwise drop AWS Builder)
- [ ] Main repo: commit, create a **public** GitHub repo, push (the MIT LICENSE is included)
- [ ] `mcp-manifest-guard`: commit, create a public repo, push; fill in the Open Source URLs above
- [ ] Record the video (under 3 minutes, public on YouTube or Vimeo, English, no copyrighted music)
- [ ] Paste the description, built-with list, feedback, friction log and tracks into Devpost
