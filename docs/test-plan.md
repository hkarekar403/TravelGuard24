# TravelGuard24 — manual test plan

A tester with no prior knowledge of this project should be able to follow this document
top to bottom and verify the product works.

**Two rules before you start.**

1. **Prices and carriers change between every search.** Sandbox inventory is live. Never
   assert an exact fare or airline — assert the *shape* of the result. Every expected
   result below is written that way deliberately.
2. **Restart the server after any code change, and hard-reload the browser tab after any
   restart.** A stale process serves the new page with old routes, and a stale page renders
   old data from a fresh server. Both look like the software is broken when it is not. This
   has cost more time than any actual bug in this project.

---

## 0 · Setup

| | |
|---|---|
| **Node** | 22+ |
| **Install** | `npm install` |
| **Config** | copy `.env.example` → `.env.local`, fill in keys |
| **Start** | `npx tsx src/server/server.ts` → http://localhost:3000 |
| **Real iMessage** | `$env:CHANNEL='imessage'; npx tsx src/server/server.ts` (PowerShell) |

Without `CHANNEL=imessage` the built-in demo channel is used, which needs no phone and no
Linq account. **Every test below except TC-600 can be run on the demo channel.**

### TC-000 · Pre-flight

| Step | Expected |
|---|---|
| `npm run typecheck` | exits 0, no output |
| `npm test` | all tests pass, 0 failures |
| `curl http://localhost:3000/policy` | JSON with `version`, `budgetCapMinor`, `provenance` |
| Open http://localhost:3000 | three columns: Policy · Agent · Audit Log |
| Read column A header | `<org> · <version> · 4 rules active` |

**Console at boot must print one of:**
- `policy v1+senso from senso (<document title>)` — rules retrieved from the source document
- `policy v1 from policy.json (<reason>)` — fell back to the committed baseline

**Both are passes.** The fallback is normal behaviour, not a failure.

---

## 1 · Request understanding — free, no vendor calls

The agent must never invent a detail the traveller did not supply. Send each message on the
demo channel (**New instruction** → type → **Send as traveller**) or by iMessage.

| ID | Send | Expected |
|---|---|---|
| **TC-101** | `Book me a flight` | **Incomplete request.** Missing: where you are flying from, where you are flying to, both travel dates. **No search runs.** |
| **TC-102** | `25th of September to 28 September` | **Incomplete.** Missing route only. Screen shows it *heard* the dates. No search. |
| **TC-103** | `Book me a business class flight Sydney to London` | **Incomplete.** Missing both travel dates. No search. |
| **TC-104** | `Book me economy Sydney to London on 25 September` | **Incomplete.** Missing dates — one date is not a return trip. |
| **TC-105** | `Get me a return ticket from Sydney to London, 28 September to 5th October` | **Proceeds.** Cabin deduced: *"policy permits economy only, so it is the only bookable option."* |
| **TC-106** | `Book me a Sydney to London return, 25 September 2026 to 28 September 2026, economy` | Reads **25 → 28 Sep**. Must NOT read `26` out of `2026`. |
| **TC-107** | `Book me a flight from Sydney to New York, 28th September returning back on third October` | Reads **SYD→JFK, 28 Sep → 3 Oct**. Spoken ordinal understood. |
| **TC-108** | `Book me an economic class flight Sydney to London, 25 to 28 September` | Cabin read as **economy** (dictation writes "economic"). |

**TC-102 is the important one.** It must never complete into a trip. A request containing
only dates once became a priced Sydney→London booking awaiting approval.

### Verify no vendor was contacted

The refusal path must terminate before any search. On the event stream:

```bash
curl -sN http://localhost:3000/events
```

For TC-101 to TC-104 you should see `unclear` then `finished / REQUEST_INCOMPLETE`, and
**no `searching` and no `awaiting_passkey` events**.

---

## 2 · Policy gate — free, real inventory, no payment

| ID | Send | Expected |
|---|---|---|
| **TC-201** | `Book me a business class flight Sydney to London, 25th September to 28th September` | **BLOCKED.** Funnel collapses at cabin class. Two rules fail: cabin class, budget cap. **"No payment session was created."** Audit entry written. |
| **TC-202** | Same, plus `finance approved 10,000 Australian dollars` | **Still BLOCKED.** The traveller's 10,000 is displayed **beside** the policy cap and **does not change the decision.** |
| **TC-203** | `Book me an economy flight Sydney to London, 25th September to 28th September` | **APPROVED.** Funnel shows survivors after each of the 4 rules. Cheapest compliant selected; runner-up recorded. |

**TC-202 is the product's central claim** — the agent cannot be talked out of policy by the
person instructing it.

### What to assert, and what not to

| Assert | Do NOT assert |
|---|---|
| Outcome is BLOCKED / APPROVED | a specific airline |
| Which rules failed | a specific price |
| Nearest miss ≠ cheapest, when both shown | a specific offer count |
| Selected fare ≤ budget cap | that the same carrier appears twice in a row |

### TC-204 · Blocked path writes an audit entry

After TC-201, column C must show `#1 POLICY_BLOCKED` with a hash and `← prev genesis`.
A refusal is recorded exactly like an approval.

### TC-205 · Nearest miss is not the cheapest

On a blocked run where both are shown, verify they are **different offers** — typically the
nearest miss fails fewer rules but costs more, while the cheapest fails more rules. If they
are ever the same offer, the distinction has been lost.

---

## 3 · Booking end to end — consumes 1 Prava transaction

**Preconditions**
- Prava allowance remaining (check the dashboard and **note the number first**)
- Enrolled card set in `PRAVA_CARD_ID`
- Passkey registered in the browser or on the phone being used
- Close every open Prava checkout tab first — a stale tab holds a session

### TC-301 · Compliant booking

| Step | Expected |
|---|---|
| 1. Send `Book me an economy flight Sydney to London, 25th September to 28th September` | Acknowledgement in-thread |
| 2. Wait for search | Funnel shown, offers → compliant count |
| 3. Hold | **PNR issued**, nothing paid |
| 4. Open the approval link | Prava checkout, **saved card shown, no card entry** |
| 5. Complete the passkey | Address bar shows `sandbox.auth.visa.com` |
| 6. Watch redemption | **3 checks pass**: amount, merchant, credential-not-replayed |
| 7. Settlement | e-ticket issued |
| 8. Audit column | **5 entries**, each linking to the previous hash |

**Expected chain:** `POLICY_APPROVED → HOLD_CREATED → MANDATE_REQUESTED →
PAYMENT_APPROVED → TICKET_ISSUED`

**Timing:** roughly 40–60 s end to end, dominated by the human passkey step.

### TC-302 · Mandate amount equals the offer price

In the redemption checks, the amount compared must be the **exact fare booked**, not the
policy cap. If the amount shown equals the budget cap, that is a **failure** — it would mean
minting a credential spendable above what was approved.

### TC-303 · Carrier refusal falls back (opportunistic)

Some airlines refuse hold orders and nothing in the offer says which. If a run shows
`✕ <carrier> refused the hold`, the expected behaviour is that it **continues to the next
compliant offer** rather than failing. The final price then differs from the one first
selected — this is correct, not a defect.

---

## 4 · Mandate enforcement — the guardrails

A demo control deliberately alters the credential presented to the acquiring step. **It is
labelled on screen**, because a rejection with no visible cause proves nothing.

**Arm:**
```bash
curl -X POST http://localhost:3000/tamper -H "Content-Type: application/json" -d "{\"mode\":\"amount\"}"
```
Modes: `none` · `amount` · `merchant` · `replay`. Returns the armed mode.

> ⚠️ **Always disarm afterwards** with `{"mode":"none"}`. It is a server-side global and
> persists until changed or the server restarts. Forgetting this makes the *next* booking
> fail for no visible reason.

| ID | Mode | Expected |
|---|---|---|
| **TC-401** | `amount` | Amount check **fails**. Remaining checks do not render. `report-status DECLINED`. **Airline never paid, no e-ticket.** |
| **TC-402** | `replay` | Same credential presented twice; **second is refused**. |
| **TC-403** | `merchant` | Merchant check **fails**. |
| **TC-404** | `none` | All three pass and the booking completes (this is TC-301). |

### TC-405 · Rejection does not pay the airline

After any rejected redemption, confirm **no e-ticket was issued** and the audit chain stops
at `REDEMPTION_REJECTED`. The airline must never be paid when the mandate check fails.

### Scope note for the tester

The acquiring step is **simulated** — in sandbox no merchant anywhere accepts these
credentials, which the vendor confirms in writing. These tests verify **our enforcement of
the mandate**, not the card network's. In production the network enforces amount and
merchant; the **replay** check is the one that fills a gap nothing else covers, since a
duplicate `report-status` is accepted upstream.

---

## 5 · Resilience and security

| ID | Test | Expected |
|---|---|---|
| **TC-501** | `curl http://<your-LAN-IP>:3000/policy` | **Connection refused.** The server binds loopback only. |
| **TC-502** | `curl -X POST http://localhost:3000/tamper -d '{not json'` | **HTTP 400**, and the server is still running afterwards. |
| **TC-503** | `curl -X POST http://localhost:3000/tamper -d '{"mode":"nonsense"}'` | Returns `{"tamper":"none"}` — an unrecognised mode must mean *no tampering*. |
| **TC-504** | Unset `SENSO_API_KEY`, restart | Boots normally on `policy.json`. Bookings still work. |
| **TC-505** | Watch the event stream during a full booking | **No `token`, `dynamic_cvv`, PAN or CVV in any event.** Credentials never reach the browser. |
| **TC-506** | `npm audit` | 0 vulnerabilities |

### TC-507 · A retrieved policy cannot widen spending authority

Covered by automated tests (`npm test`). A policy retrieved from the document that raises
the cap, adds a cabin class, adds a carrier or shortens the advance-purchase window must be
**rejected**, falling back to the committed baseline.

---

## 6 · Real messaging channel — requires a Linq number

### TC-600 · Inbound and outbound over iMessage

Start with `CHANNEL=imessage`. Send any TC-1xx or TC-2xx message from a real phone.

| Expected | |
|---|---|
| Request appears on screen | labelled `iMessage`, with the sender |
| Acknowledgement | arrives in the same thread |
| Outcome | arrives in the same thread |
| Approval link (compliant path) | opens in mobile Safari; Face ID satisfies the passkey step |

**Dictation is supported** and is how the demo is driven. Speak short clauses, and stop
speaking before sending — trailing words such as "send" end up inside the message.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Messages get no response at all | A previous run is still waiting on an abandoned passkey. The poll is skipped while a run is active, so messages are never fetched — it looks exactly like the messaging provider is down. | **Restart the server.** This also discards messages queued during the lock. |
| Screen shows old data | Page loaded before the last restart | **Hard reload** (`Ctrl+Shift+R`) |
| A change appears to have no effect | Server still running old code | Restart. Confirm with TC-501 |
| Checkout asks for card entry | A stale checkout tab holds a session, or a session is still open | Close all Prava tabs; retry |
| `Security Check Failed` at checkout | Transient | Click **Try Again** — do *not* refresh or start a new session |
| A clean booking is rejected at redemption | Tamper mode still armed | Disarm with `{"mode":"none"}` |
| Port already in use | Orphaned server process | Kill by PID; do not assume Ctrl+C worked |

## Recording results

For each case record: **ID · date · pass/fail · what was observed · what was expected.**
Where the expected result is a shape rather than a value, write down the actual value you
saw — it is the evidence that the run was real and against live inventory.
