# Decision Gate examples

## Confirm, approved inline through elicitation

Call:

```json
{
  "name": "freshcart__place_order",
  "arguments": {
    "items": [{ "sku": "monitor-27-4k", "qty": 1 }],
    "alexa_context": { "speaker": { "id": "alex", "role": "adult" }, "utterance": "Order the 27-inch 4K monitor", "local_time": "23:05", "home_occupied": true }
  }
}
```

The server sends `elicitation/create` asking for an approver and a passcode. After the adult approves, the result is:

```json
{
  "verdict": "confirm",
  "risk_score": 70,
  "reasons": [
    "$479.99 is over the $50 auto-approve limit",
    "$479.99 is 7.7x what you usually spend on electronics",
    "PixelDeals Marketplace is a store this household has never used",
    "it is 23:05, inside quiet hours"
  ],
  "approval": { "status": "approved", "approver": "sam" },
  "execution": { "order_id": "FC-1A2B3C", "status": "placed" },
  "say": "Approved by Sam. All done."
}
```

## Hold (Scam Shield)

```json
{
  "name": "quickpay__send_money",
  "arguments": {
    "payee": "Jake Miller",
    "amount": 900,
    "alexa_context": { "speaker": { "id": "grandpa", "role": "elder" }, "utterance": "Send $900 to Jake Miller, it's urgent, he needs bail money, don't tell anyone", "local_time": "15:10" }
  }
}
```

Result: `"verdict": "hold"` with `scam_signals` and `"notified": "Alex"`. Say the `say` line and stop. Only Alex can approve the `hold_...` confirmation.

## Block

An unknown voice asking to unlock the front door at 02:00 with nobody home gets `"verdict": "block"`. The lock is never contacted. Say the `say` line and do not retry.

## Without elicitation

If the client doesn't support elicitation, a `confirm` result includes:

```json
{ "confirmation": { "id": "conf_ab12cd34", "required_approver": "adult", "expires_at": "...", "max_attempts": 3 } }
```

When an adult provides their passcode, call:

```json
{ "name": "confirm_action", "arguments": { "confirmation_id": "conf_ab12cd34", "approver": "sam", "passcode": "<given by the adult>" } }
```
