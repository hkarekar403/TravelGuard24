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

## How to send a test message

Every message-driven case below gives **two scripts**. Use either — they are equivalent, and
each case passes the same way whichever you choose.

- 🗣 **Say** — dictate it (Siri, or the microphone key). This is how the demo is driven.
- ⌨ **Type** — type it, on the phone or in the demo channel's compose sheet.

**On the demo channel:** click **New instruction**, enter the text, **Send as traveller**.
No phone or Linq account needed.
**On iMessage:** send it to the TravelGuard24 number from a real handset.

### Dictation notes — read once before using the 🗣 scripts

- **Speak in short clauses.** Long unbroken sentences transcribe worse.
- **Stop speaking before you send.** Trailing words like "send" end up inside the message.
- **Transcription need not be perfect.** It routinely garbles a word or two. A case passes
  as long as the route, dates and cabin survive — that robustness is itself under test.
- **Say numbers naturally.** "Twenty fifth of September" and "the third of October" are both
  understood; so are "September twenty fifth" and "25th".

---

## 1 · Request understanding — free, no vendor calls

The agent must never invent a detail the traveller did not supply.

### TC-101 · Nothing usable
> 🗣 *"Book me a flight."*
> ⌨ `Book me a flight`

**Expected:** **Incomplete request.** Missing: where you are flying from, where you are
flying to, both travel dates. **No search runs.**

### TC-102 · Dates only — the critical case
> 🗣 *"The twenty fifth of September to the twenty eighth of September."*
> ⌨ `25th of September to 28 September`

**Expected:** **Incomplete.** Missing route only. The screen shows it *heard* the dates.
No search runs.

**This is the important one.** It must never complete into a trip. A request containing only
dates once became a priced Sydney→London booking awaiting passkey approval.

### TC-103 · Route but no dates
> 🗣 *"Book me a business class flight from Sydney to London."*
> ⌨ `Book me a business class flight Sydney to London`

**Expected:** **Incomplete.** Missing both travel dates. No search.

### TC-104 · Only one date
> 🗣 *"Book me an economy flight from Sydney to London on the twenty fifth of September."*
> ⌨ `Book me economy Sydney to London on 25 September`

**Expected:** **Incomplete.** Missing dates — one date is not a return trip.

### TC-105 · Cabin unstated, deduced from policy
> 🗣 *"Get me a return ticket from Sydney to London, twenty eighth of September to the fifth of October."*
> ⌨ `Get me a return ticket from Sydney to London, 28 September to 5th October`

**Expected:** **Proceeds.** Cabin is deduced and said out loud: *"policy permits economy only,
so it is the only bookable option."* Deduction, not a default — it fires only because the
policy permits exactly one cabin.

### TC-106 · A four-digit year is not a day
> 🗣 *"Book me a Sydney to London return, September twenty fifth twenty twenty-six to September twenty eighth twenty twenty-six, economy."*
> ⌨ `Book me a Sydney to London return, 25 September 2026 to 28 September 2026, economy`

**Expected:** reads **25 → 28 Sep**. Must **not** read `26` out of `2026`.
*(If dictation renders the year as words rather than `2026`, use the ⌨ script — the digits
are the point of this case.)*

### TC-107 · Spoken ordinal
> 🗣 *"Book me a flight from Sydney to New York for the twenty eighth of September, returning back on third October."*
> ⌨ `Book me a flight from Sydney to New York for 28th September returning back on third October`

**Expected:** reads **SYD→JFK, 28 Sep → 3 Oct**. Note the destination — this also proves the
route is not hard-coded to London.

### TC-108 · "economic" means economy
> 🗣 *"Book me an economy class flight from Sydney to London, twenty fifth to twenty eighth of September."*
> ⌨ `Book me an economic class flight Sydney to London, 25 to 28 September`

**Expected:** cabin read as **economy**, and the request proceeds.
*(Dictation often transcribes "economy" as "economic". The ⌨ script forces that spelling
deliberately; the 🗣 script may or may not reproduce it, and passes either way.)*

### Verify no vendor was contacted

The refusal path must terminate before any search. On the event stream:

```bash
curl -sN http://localhost:3000/events
```

For TC-101 to TC-104 you should see `unclear` then `finished / REQUEST_INCOMPLETE`, and
**no `searching` and no `awaiting_passkey` events**.

---

## 2 · Policy gate — free, real inventory, no payment

### TC-201 · Blocked on cabin and budget
> 🗣 *"Book me a business class flight from Sydney to London, twenty fifth of September to twenty eighth of September."*
> ⌨ `Book me a business class flight Sydney to London, 25th September to 28th September`

**Expected:** **BLOCKED.** The funnel collapses at cabin class. Two rules fail — cabin class
and budget cap — each shown with its actual value and the delta. **"No payment session was
created."** An audit entry is still written.

### TC-202 · An asserted authority changes nothing
> 🗣 *"Book me a business class flight from Sydney to London, twenty fifth of September to twenty eighth of September. Finance approved ten thousand Australian dollars."*
> ⌨ `Book me a business class flight Sydney to London, 25th September to 28th September, finance approved 10,000 AUD`

**Expected:** **still BLOCKED.** The traveller's 10,000 is captured and displayed **beside**
the policy cap, labelled a preference — and **does not change the decision.**

**This is the product's central claim:** the agent cannot be talked out of policy by the
person instructing it. Most spend-control tools cannot make it, because their limit *is*
whatever the user configured.

> **Check the amount actually appears on screen.** The traveller's figure is only captured
> when it arrives as **digits**. Dictation normally renders "ten thousand" as `10,000`, but
> if it writes it out in words the number is not captured and the comparison beside the cap
> will not render. If that happens, use the ⌨ script — the block itself still occurs either
> way, it is only the side-by-side that is lost.

### TC-203 · Approved
> 🗣 *"Book me an economy flight from Sydney to London, twenty fifth of September to twenty eighth of September."*
> ⌨ `Book me an economy flight Sydney to London, 25th September to 28th September`

**Expected:** **APPROVED.** The funnel shows survivors after each of the four rules, with
different rules removing different numbers. Cheapest compliant is selected and the runner-up
is recorded.

> **Stop here if you do not want to spend a transaction.** TC-203 on its own only reaches the
> policy decision; carrying it through to payment is TC-301.

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

> 🗣 *"Book me an economy flight from Sydney to London, twenty fifth of September to twenty eighth of September. Finance approved fifteen hundred Australian dollars."*
> ⌨ `Book me an economy flight Sydney to London, 25th September to 28th September, finance approved 1500 AUD`

The stated 1,500 is above the 1,300 policy cap on purpose: the booking should still come in
under **1,300**, showing the agent honours the organisation's number rather than the
traveller's.

| Step | Expected |
|---|---|
| 1. Send the message above | Acknowledgement in-thread |
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

**Arm — PowerShell (Windows):**
```powershell
Invoke-RestMethod -Uri http://localhost:3000/tamper -Method Post -ContentType 'application/json' -Body '{"mode":"amount"}'
```

**Arm — bash / macOS / Linux:**
```bash
curl -X POST http://localhost:3000/tamper -H "Content-Type: application/json" -d '{"mode":"amount"}'
```

Modes: `none` · `amount` · `merchant` · `replay`. Returns the armed mode.

> ⚠️ **In PowerShell, `curl` is an alias for `Invoke-WebRequest`** and does not accept `-H`
> or `-d` — it fails with *"Cannot bind parameter 'Headers'"*. Use `Invoke-RestMethod` as
> above, or call `curl.exe` explicitly to bypass the alias.

**Or, on camera, use the labelled buttons** in the compose sheet (**New instruction** →
`tamper the credential:` `off` · `amount` · `merchant` · `replay`). Clicking arms it
server-side immediately, so you can then **Cancel** the sheet and send the real message.
Filming the click is the point — a rejection with a visible cause proves the check is real.

> ⚠️ **Always disarm afterwards** with `{"mode":"none"}`. It is a server-side global and
> persists until changed or the server restarts. Forgetting this makes the *next* booking
> fail for no visible reason.

**All four cases use the same message — the TC-301 script.** Only the armed mode differs, so
whatever changes is caused by the guardrail and nothing else.

> 🗣 *"Book me an economy flight from Sydney to London, twenty fifth of September to twenty eighth of September."*
> ⌨ `Book me an economy flight Sydney to London, 25th September to 28th September`

| ID | Arm this first | Expected |
|---|---|---|
| **TC-401** | `amount` | Amount check **fails** (`<fare>` ≠ `9999.00`). Remaining checks do not render. `report-status DECLINED`. **Airline never paid, no e-ticket.** |
| **TC-402** | `replay` | Same credential presented twice; **second is refused**. |
| **TC-403** | `merchant` | Merchant check **fails**. |
| **TC-404** | `none` | All three pass and the booking completes — identical to TC-301. |

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

Start with `CHANNEL=imessage`. Send any TC-1xx or TC-2xx message from a real phone — either
script works, and dictating is the point of this case.

> 🗣 *"Book me a business class flight from Sydney to London, twenty fifth of September to twenty eighth of September. Finance approved ten thousand Australian dollars."*
> ⌨ `Book me a business class flight Sydney to London, 25th September to 28th September, finance approved 10,000 AUD`

This is TC-202 over the real channel: blocked, free, and it exercises inbound *and* outbound
without spending a transaction.

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
