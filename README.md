# TravelGuard24

**An agent that books real flights — and refuses to book the ones it shouldn't.**

Most agentic-commerce demos answer *"can an agent complete a purchase?"* That question is
largely settled. TravelGuard24 answers the one that decides whether any of this is
deployable inside a company: **should this purchase happen at all, and can you prove
afterwards why it did or didn't?**

A traveller sends an iMessage. The agent searches live airline inventory, evaluates every
fare against a corporate travel policy, and then either books it — with a payment credential
network-locked to that exact fare — or blocks it, names the rule that failed, and writes a
tamper-evident audit entry either way.

The blocked path is not the error case. It is the product.

---

## The problem

Give an agent a card and you have automated spending. You have not automated *governance*.

Corporate travel already has rules — a budget cap, an economy-only policy, a 14-day advance
purchase window, a list of approved carriers. Today those rules are enforced by a human in a
travel management company, or by a post-hoc expense report that discovers the violation a
month after the money left.

An agent that books travel needs those rules enforced **before** it spends, not after. And
when it declines, the refusal has to be as auditable as the approval — because "the AI
wouldn't let me book it" is only acceptable if the system can say exactly which rule fired,
by how much, and against what alternatives.

That is what this builds.

---

## What actually happens

```
 iPhone ──iMessage──▶ Linq ◀──poll── TravelGuard24
   │                                       │
   │                          ┌────────────┴────────────┐
   │  ◀── acknowledgement ────┤  parse the request      │
   │                          │  Duffel: search live    │──▶ ~1,500 real fares
   │                          │  ★ POLICY GATE ★        │
   │                          └────────────┬────────────┘
   │                                       │
   │        ┌───────── BLOCKED ────────────┤
   │  ◀─────┤ rules failed + price delta   │   No payment session is created.
   │        │ audit entry written          │   Flow ends here.
   │        └──────────────────────────────┘
   │                                       │
   │                                  APPROVED
   │                          Duffel: hold order ──▶ real PNR, nothing paid
   │                          Prava: session for the EXACT fare
   │  ◀── approval link ──────────────────┤
   │                                       │
  tap ──▶ Safari ──▶ Prava ──▶ sandbox.auth.visa.com
                                    │
                                FACE ID  ← the only human action in the flow
                                    │
                        network token + dynamic CVV
                                    │
                          mandate enforcement:
                       amount · merchant · replay
                                    │
                          report-status APPROVED
                                    │
                     Duffel: settle by balance ──▶ e-ticket issued
   │  ◀── PNR + e-ticket ───────────────────┘
```

**Measured end to end: 51 seconds from spoken message to issued e-ticket.** The traveller dictates
to Siri; the only other human action in the entire flow is one Face ID tap.

---

## The four layers, and why they are separate

| Layer | Question it answers | Vendor |
|---|---|---|
| **Policy source** | What are the rules? | Senso |
| **Policy gate** | Should this purchase exist? Which fare? | ours, pure, offline |
| **Mandate** | Lock a credential to *that* purchase | Prava |
| **Authentication** | Is this really the cardholder? | Visa |

The order is the point. The money layer is never reached unless the policy layer says yes —
which is why a blocked booking consumes no payment quota at all. It terminates three steps
before a session exists.

### The policy gate

Runs **before** any mandate exists, over a real result set. It evaluates four rules — cabin
class, vendor allowlist, advance purchase, budget cap — against every offer, in that order,
producing a funnel that is shown on screen. From an actual run:

```
Searching Duffel ................ 340 offers / 18 airlines
Evaluating against 4 rules ...... 340 → 340 → 312 → 312 → 4 compliant
```

Each rule does distinct work: the allowlist removes 28 carriers, the budget cap removes a
further 308. Among the survivors it selects the cheapest **and records the runner-up** —
British Airways at 1,169.89 over American Airlines at 1,172.84 — so *"why this flight?"* is
answerable from the audit log rather than from trust.

When nothing is compliant it blocks, and reports the **nearest miss and its delta** — not
"a compliant alternative", because by definition none exists:

```
BLOCKED — 2 policy rules failed

  Cabin class     business        policy allows economy only
  Budget cap      7,881.28 AUD    cap 1,300.00 AUD   over by 6,581.28

  310 business fares evaluated. None compliant.
  No payment session was created.
```

The nearest miss and the cheapest fare are **different offers**, and that distinction earns
its keep: in that run the nearest miss was British Airways at 7,881.28 failing two rules,
while the cheapest was Asiana at 7,096.97 failing three — including a carrier the
organisation has never approved. Reporting only the cheapest would call a three-rule failure
"close".

The gate is pure — no I/O, no clock reads, `now` injected — so its behaviour is fully
determined by fixtures and fully testable without touching a vendor.

### Where the rules come from

`policy.json` restates rules that actually live in a signed document. That restatement is
unevidenced: the audit entry cites a JSON literal a developer typed, not the clause a CFO
approved.

Senso ingests the policy document and answers against it with citations, and the gate is
handed those rules instead. The screen names the source it is enforcing.

Two properties make this safe to put in front of a spending decision:

- **It can only tighten.** A retrieved policy that raises the cap, adds a cabin class, adds
  a carrier, or shortens the advance window is **rejected, not applied**. Nothing arriving
  over the network can widen spending authority. The worst case of a bad retrieval or a
  poisoned knowledge base is that the committed baseline is used; the second-worst is that
  the agent is stricter than intended.
- **It cannot fail the booking.** No key, timeout, non-2xx, unparseable answer, schema
  violation and guard violation all fall back to `policy.json` and record why. Resolution
  happens once at startup, so a booking never waits on it.

So: *"you let a retrieval pipeline set your spending limit?"* — it can only lower it.

### The mandate

The policy cap **gates the decision**. It never becomes the mandate amount. The approved
offer's exact price is what gets network-locked — sending the cap would mint a credential
spendable above what was approved, which is weaker than a plain checkout.

Before the transaction is confirmed, our own redemption step enforces the mandate rather
than rubber-stamping it, rejecting:

- an amount that differs from the mandate amount, by any margin
- a merchant that is not the one the mandate names
- a **replayed credential**, deduplicated on `txn_ref_id` and `token:cvv`

Never on the token alone — the network token is **stable per enrolled card** (verified
identical across four completed transactions; only the dynamic CVV changes). Token-based
deduplication would reject every legitimate repeat purchase by the same traveller.

### The audit log

Every attempt writes an entry, **including blocked ones** — a refusal is evidence, not a
non-event. Entries are chained by SHA-256, each embedding its predecessor's hash.

Stated precisely: this proves **ordering and integrity, not authorship**. A hash chain alone
does not prove who wrote an entry. Signing keys would, and are the obvious next step.

---

## Visa Intelligent Commerce

Pillars 1 and 2 are what every agentic-commerce demo shows. **This project's argument is
pillars 3 and 4.**

| Pillar | Coverage |
|---|---|
| 1 · Tokenized credentials | Real network token + dynamic CVV via Prava |
| 2 · User authenticated on instruction | Real WebAuthn passkey — Face ID, on Visa's own domain |
| 3 · **Controls aligning payment to intent** | **The policy gate — the whole product** |
| 4 · **Commerce signals** | **Hash-chained audit log covering approvals *and* refusals** |

Visa frames pillar 3 as aligning payment with the user's own instruction. TravelGuard24
extends it one layer: aligning payment with the **organization's** policy, enforced before
the mandate exists.

**A traveller cannot talk the agent out of it, and both demo runs prove it.** The blocked
request asserted *"finance approved 10,000 AUD for this trip"* — the gate applied Acme's
1,300 cap and refused. The approved request claimed 1,500, also above policy, and the
booking landed at 1,169.89. The agent honours the organisation's number, not the number
the person instructing it supplies. That claim is the one most spend-control demos cannot
make, because their limit *is* whatever the user configured.

**The passkey step runs on `sandbox.auth.visa.com/.../payment-credential-authentication`** —
pillar 2 evidenced by a third party, visible in the address bar during the demo. Enrolment
hits `payment-credential-binding`; repeat purchases hit `-authentication` only, which is what
makes "one tap, zero typing" checkable rather than claimed.

### How this composes with Prava's own guardrails

Prava ships mandate constraints — merchant, amount threshold, frequency, duration. A fair
question is whether the policy gate duplicates them. It does not:

| | Prava guardrails | TravelGuard24's gate |
|---|---|---|
| **When** | Bound a mandate that already exists | Runs **before** any mandate is created |
| **Asks** | How much, where, how often? | ***Whether*, and *which one*?** |
| **Inputs** | Amount, merchant, frequency | Cabin, advance window, carrier, cap — across a real result set |
| **Output** | Allow / decline a charge | **Selects a fare**, or blocks with the rule and delta |

The gate decides *which* purchase should exist; the mandate then network-locks *that*
purchase. They compose.

---

## What is real, and what is simulated

Everything is real except one deliberately disclosed step.

**Real:** the inbound iMessage · live Duffel search over ~1,500 fares · the policy
evaluation · the Duffel hold order and its PNR · the Prava session and mandate · the Visa
passkey ceremony · the network token and dynamic CVV · our mandate enforcement ·
`report-status` and `visa_confirmation: SUCCESS` · the Duffel balance settlement · **the
issued e-ticket** · the audit chain.

**Simulated:** the card-acquiring step — running the Prava-issued credential through an
acquirer to move money from the traveller to TravelGuard24.

**Why, and why it is not a shortcut.** Sandbox environments do not validate each other's
credentials. Confirmed empirically against Duffel (`403 unavailable_feature` on the card
vault; `422` demanding a `card_id` that only that endpoint can mint) and confirmed by Prava
engineering in writing:

> *"a sandbox token cannot be used to complete a live transaction... For the hackathon, you
> can submit the sandbox token on the merchant checkout screen and allow the transaction to
> be rejected (completely acceptable for the hackathon if payment is rejected in final step
> by merchant checkout screen). In production, this flow works seamlessly as the system
> generates live credentials."*

Prava's sanctioned path ends in a decline. **Ours completes, issues a real e-ticket, and
enforces the mandate on the way through** — the simulated merchant validates amount, merchant
and replay, so the one modelled component demonstrates pillars 1 and 3 rather than papering
over them.

Visa's own materials describe merchant acceptance of these credentials as *"guest checkout,
key entry (form fill)"* — so the modelled step reflects the real mechanism.

**Settlement model.** TravelGuard24 is the merchant of record, on the travel-management-company
model: a TMC genuinely is the billing entity, charges the corporate card, and settles with
carriers itself. Leg 1 (traveller → TravelGuard24) is the Prava credential. Leg 2
(TravelGuard24 → airline) is a Duffel `balance` agency settlement, and **fires only if leg 1
succeeded.** That conditionality is the integration: remove Prava and leg 2 has no trigger.

---

## Running it

```bash
npm install
cp .env.example .env.local     # Prava, Duffel, Linq, Senso keys
npx tsx src/server/server.ts   # http://localhost:3000
```

Everything is localhost. Nothing connects inward — Linq is polled rather than webhooked, and
Prava has no webhooks, so outcomes are polled. No deployment, no tunnel.

```bash
npm test           # 121 tests
npm run typecheck
```

For the real iMessage channel: `CHANNEL=imessage`. Omit it for the built-in demo channel,
which stays watched either way.

---

## Deliberately out of scope

Stated rather than discovered:

- **No exception/override path.** Real corporate policy has one. Ours does not, and the UI
  says so on screen.
- **No re-search with relaxed constraints** when blocked. Showing the nearest miss is v1;
  negotiating the policy is a whole feature.
- **Duffel's card payment path is never used** — structurally incompatible with routing a
  third-party tokenized credential, verified twice.
- Hotels, car hire, multi-passenger, per-traveller caps, fare-brand rules, currency
  conversion (a non-AUD fare is excluded, not converted).

---

## Where this goes next

- **Re-run the gate on airline-initiated changes.** If a carrier reschedules a booked
  flight, the new itinerary may no longer satisfy policy. Duffel already emits the event.
- **Sign the audit chain**, upgrading it from ordering and integrity to authorship.
- **Grade-based policy** — the most common real-world variation.
- **Provider-agnostic gate.** Nothing in it is Duffel-specific; it consumes offers.

---

## Built for the Agentic Commerce Hackathon, 1–3 August 2026

**Pre-existing work disclosure.** Before the event this repository contained only a
`.gitignore` — no product code. Prior work was API familiarisation, captured sandbox
fixtures, and written architecture decisions. Every line of the product was written during
the event window and is visible in the commit history.
