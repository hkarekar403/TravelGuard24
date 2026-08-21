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

**▶ Demo video — [youtu.be/UQTnfvQ5KaU](https://youtu.be/UQTnfvQ5KaU)**
A refusal and a booking, both against live airline inventory, driven from a phone.

**Try the policy gate yourself — [travelguard24.onrender.com](https://travelguard24.onrender.com)**
Live search and the full policy decision, with the payment path disabled: the hosted instance
holds no payment credentials, so it decides and stops. The booking half is in the video.
It sleeps when idle, so the first load can take up to a minute.

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
   │                          │  Duffel: search live    │──▶ every live fare
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

**Measured end to end: 41 seconds from the message arriving to the e-ticket issuing.** The
traveller dictates to Siri; the only other human action in the entire flow is one Face ID tap.

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
Searching Duffel ................ 335 offers / 17 airlines
Evaluating against 4 rules ...... 335 → 335 → 303 → 303 → 4 compliant
```

Each rule does distinct work: the allowlist removes 32 fares, the budget cap removes a
further 299. Among the survivors it selects the cheapest **and records the runner-up** —
British Airways at 1,178.59 over Iberia at 1,201.94 — so *"why this flight?"* is
answerable from the audit log rather than from trust.

When nothing is compliant it blocks, and reports the **nearest miss and its delta** — not
"a compliant alternative", because by definition none exists:

```
BLOCKED — 2 policy rules failed

  Cabin class     business        policy allows economy only
  Budget cap      7,915.37 AUD    cap 1,300.00 AUD   over by 6,615.37

  314 business fares evaluated. None compliant.
  No payment session was created.
```

The nearest miss and the cheapest fare are **different offers**, and that distinction earns
its keep: in that run the nearest miss was Iberia at 7,915.37 failing two rules, while the
cheapest was 7,096.97 failing three — including a carrier the organisation has never
approved. Reporting only the cheapest would call a three-rule failure "close".

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
request asserted *"finance approved AU$10,000"* — the gate applied Acme's 1,300 cap and
refused. The approved request claimed 1,500, also above policy, and the booking landed at
1,178.59. The agent honours the organisation's number, not the number
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

**Real:** the inbound iMessage · live Duffel search over real fares · the policy
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

Nothing connects inward — Linq is polled rather than webhooked, and Prava has no webhooks, so
outcomes are polled. There is no tunnel and no inbound callback, which is what lets the entire
booking flow run from a laptop.

The hosted instance is the same code with **`PUBLIC_DEMO=1`**: it runs discovery and the policy
gate against live inventory and stops there, never reserving a seat or requesting a mandate. It
is deployed with no payment credentials at all, so "this instance cannot spend" is a property of
its environment rather than a flag someone could flip. The server binds **loopback unless told
otherwise** — a deployment that needs a public interface sets `HOST` explicitly, so "nothing
connects inward" stays true of every instance that has not opted out.

```bash
npm test           # 174 tests (1 skips without the full capture)
npm run typecheck
```

**A manual test plan is in [`docs/test-plan.md`](docs/test-plan.md)** — 30 numbered cases a
tester with no prior knowledge of the project can follow, covering request understanding,
the policy gate, an end-to-end booking, the mandate guardrails, and the security properties.
Everything except the booking and guardrail cases runs without spending anything.

Two things it opens with, because they cost more time than any real bug: **sandbox prices
and carriers change between every search**, so assert the shape of a result and never an
exact fare; and **restart the server after a code change, hard-reload the tab after a
restart** — a stale process serves the new page with old routes, and a stale page renders
old data from a fresh server.

For the real iMessage channel: `CHANNEL=imessage`. Omit it for the built-in demo channel,
which stays watched either way.

---

## Deliberately out of scope

Stated rather than discovered:

- **One traveller, not many.** The Prava customer, the card and the passenger details are
  fixed to a single demo traveller. In a real deployment all three come from a traveller
  profile keyed to the sender — each employee being their own Prava customer, with their own
  enrolled card and their own passkey, and the card resolved per traveller rather than
  configured. `PRAVA_CARD_ID` exists because this demo customer has two cards enrolled and
  the older one's network token died mid-event; without the pin the checkout offers the dead
  card. It is a workaround for that, not a position on how identity should work. What it
  would take: the profile lookup is small, but every traveller needs a one-time enrolment on
  their own device, which is not something a weekend can fake.
- **No exception/override path.** Real corporate policy has one. Ours does not, and the UI
  says so on screen.
- **No re-search with relaxed constraints** when blocked. Showing the nearest miss is v1;
  negotiating the policy is a whole feature.
- **Duffel's card payment path is never used** — structurally incompatible with routing a
  third-party tokenized credential, verified twice.
- Hotels, car hire, multi-passenger, per-traveller caps, fare-brand rules, currency
  conversion (a non-AUD fare is excluded, not converted).

---

## Compliance posture

A project about enforcing compliance should be precise about its own. **Nothing here is
"compliant"** — compliance is an audited assertion about an operating organisation, not a
property of a codebase. What follows is what the architecture actually does, and what it
does not.

### PCI DSS — the scope is deliberately near-zero

**TravelGuard24 never touches a PAN.** Card entry happens entirely inside Prava's iframe on
Prava's domain; Prava holds PCI DSS Level 2 / SAQ-D and vaults with Skyflow (Level 1). We
don't host a payment page — the traveller receives a link. In a production deployment that
is SAQ A territory: fully outsourced cardholder data handling, no payment page of ours in
the flow at all.

What we *do* receive is a **network token plus a dynamic CVV**. A network token is a
domain-restricted surrogate we cannot de-tokenize, so it generally falls outside PCI scope
for a token consumer — but token plus cryptogram is *transactable*, so it is handled as
though it were a PAN:

- **Never persisted.** Nothing is written to disk at runtime, at all.
- **Never logged.** The CLI prints credential *lengths*, never values.
- **Never sent to the browser.** Verified against captured event streams from real
  transactions, not by reading the code.
- **Never retained to detect its own reuse.** Replay detection keys on a SHA-256 of
  `token:dynamic_cvv`, because uniqueness is a property of the input, not of the stored
  form. Authentication data is not kept after authorisation — and in-memory is still kept.
- **Redacted from the audit record** at any depth, by key name.
- **Zero runtime dependencies**, so there is no supply chain to compromise. `npm audit` does
  report advisories, and every one of them is in the test toolchain — `vitest`, `vite`,
  `esbuild`. None of it is installed or executed by the running product; `dependencies` is
  empty. Stated this way rather than as "no vulnerabilities", because the honest claim is
  the narrower one and it is the one that survives being checked.

**Gaps, stated rather than discovered:** no authentication on the console, no key
management, no network segmentation, no monitoring or alerting.

### SOC 2 — one criterion is strong, the rest are honest gaps

| Criterion | Position |
|---|---|
| **Processing Integrity** | **Strong, and it is the product.** "Complete, valid, accurate, timely, authorised" describes the policy gate, the mandate lock, the redemption checks and the hash chain almost verbatim. |
| **Confidentiality** | Good. Credentials never persisted, logged, or transmitted to the client. |
| **Security** | Partial. Loopback-only binding and zero dependencies help; there is no authn/authz, monitoring, or incident response. |
| **Availability** | Not addressed. Single process, in-memory state, no HA. One abandoned checkout blocks the agent for 14 minutes. |
| **Privacy** | Partly addressed. The traveller's contact is **masked before it leaves the process** — the browser only ever receives `••• 0292`, so it cannot reach a screenshot or a screen recording. Still a gap: passenger name, date of birth and email are transmitted to Duffel with no retention policy, deletion path, or consent record. |

### SOC 1 — applicable in production, and it points at the same gap

A travel management company's spend flows directly into its clients' expense and financial
records, so enterprise buyers would ask for SOC 1 Type II. **The audit log is exactly the
control such a report describes** — and two known limitations currently disqualify it: the
chain is in-memory, so it does not survive the process, and a hash chain proves *ordering
and integrity, not authorship*. Durable append-only storage and signing are the work that
closes both, and they are the same work required to answer an audit question raised months
after the booking.

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
