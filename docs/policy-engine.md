# Policy engine — locked specification

The policy engine decides **whether a purchase should happen at all**, and **which offer**, before
any payment session exists. It is the gate that runs ahead of the Prava mandate.

**This document is the contract.** Implementation must not make semantic choices beyond it. Where
something is genuinely undecided it is marked **OPEN**; there are currently none.

## Scope

**In:** budget cap · cabin class · advance purchase · vendor allowlist. Offer selection among
compliant candidates. The block decision and its explanation.

**Out (v1, deliberate):** exception/override workflow · re-search with relaxed constraints ·
multi-passenger · hotels · currency conversion · change/cancellation requests.

## Non-negotiable properties

1. **Pure.** `evaluate(offers, policy, now)` performs no I/O, reads no clock, no `Date.now()`,
   no `fs`, no network. `now` is injected. This is what makes it testable offline against the
   captured fixtures and deterministic in the demo.
2. **Total.** Every offer receives a result for every rule. No short-circuiting — the blocked
   screen must be able to say *"2 rules failed"*, which requires evaluating all four.
3. **Deterministic.** Same inputs ⇒ same output, including ordering. All sorts have an explicit
   final tiebreak on `offer.id`.
4. **Fail closed.** A rule that cannot be evaluated **fails**. It never silently passes. See
   "Missing data" below — this is a security property, and it is a pitch point.

---

## Money — read this before writing any comparison

Duffel returns amounts as **decimal strings** (`"1202.75"`), not numbers.

- **Compare in integer minor units.** Parse `"1202.75"` → `120275`. Never `parseFloat` for a
  comparison or a sum. `1202.75` is not representable in binary floating point.
- **Carry the original string through untouched** to the Prava mandate. Decision 1 requires the
  mandate amount to equal the offer price *exactly*; a float round-trip can shift it by a cent and
  break the network-level amount lock, which is the mechanism the entire pitch rests on.
- Parser must accept `"1203"`, `"1203.5"`, `"1203.50"`. Reject anything else (fail closed).

```ts
/** "1202.75" -> 120275. Throws on malformed input. */
function toMinorUnits(amount: string): number
```

## Discovery filter — hold-eligibility, applied before the gate

`POST /air/orders` with `type: "hold"` fails against an offer whose
`payment_requirements.requires_instant_payment` is `true`. **Roughly two thirds of a live result
set is in that category** (1,031 of 1,669 in the captured fixture; 1,022 of 1,513 in a live search
on 1 Aug), so this is the common case, not an edge.

Such offers are removed **in the Duffel client, at discovery**, before the policy engine sees them.
They are a vendor-capability constraint, not a policy judgement — a fare we structurally cannot
transact should never reach a rule, and should certainly never be *selected* only to fail at hold.

Worth knowing because the failure is badly signposted: Duffel returns
`422 invalid_order_create_type — "The specified type was incorrect"`, which points squarely at the
request body and says nothing about the offer. It reads as a malformed request. Diagnosing it cost
real time on 1 Aug, and the first hypothesis was disproved by a verification search that happened
to return four hold-eligible offers.

## Currency

All comparisons require `offer.total_currency === policy.currency`. A mismatch is **not** a
budget failure — it is an evaluation failure, and the offer is excluded with reason
`currency_mismatch`. There is no FX in v1. (Every captured fixture is `AUD`; this guard exists so a
live search in another currency degrades safely instead of comparing unlike numbers.)

---

## Input types

Subset of the Duffel offer actually consumed. Ignore everything else.

```ts
type Offer = {
  id: string;
  total_amount: string;        // "1202.75"
  total_currency: string;      // "AUD"
  expires_at: string;          // ISO 8601, UTC ("2026-07-26T08:38:00.430894Z")
  owner: { iata_code: string; name: string };
  slices: Array<{
    fare_brand_name: string | null;   // ABSENT on ~1% of offers — v1 does not use it
    segments: Array<{
      departing_at: string;           // "2026-09-15T10:50:00" — LOCAL, no offset. See below.
      marketing_carrier: { iata_code: string; name: string };
      operating_carrier: { iata_code: string; name: string };
      passengers: Array<{ cabin_class: string }>;   // "economy" | "premium_economy" | ...
    }>;
  }>;
};
```

## Policy schema

```ts
type Policy = {
  version: string;                 // "v1"
  org: string;                     // rendered in column A
  currency: string;                // "AUD"
  budgetCapMinor: number;          // 130000 == AUD 1,300.00
  allowedCabinClasses: string[];   // ["economy"]
  minAdvanceDays: number;          // 14
  vendorAllowlist: string[];       // IATA codes, e.g. ["ZZ","IB","BA","AA", ...]
};
```

Policy is **data, not code** — a JSON file. A judge asking "can it express a different policy?"
gets a file, not a rebuild.

---

## Rule semantics

Rules are identified by a stable id and evaluated in this **display order**, which is also the
order the cumulative funnel is computed in:

| # | id | Passes when |
|---|---|---|
| 1 | `cabin_class` | **Every** segment's `cabin_class` ∈ `allowedCabinClasses` |
| 2 | `vendor_allowlist` | `owner.iata_code` ∈ `vendorAllowlist` |
| 3 | `advance_purchase` | `daysUntilDeparture >= minAdvanceDays` |
| 4 | `budget_cap` | `toMinorUnits(total_amount) <= budgetCapMinor` |

### 1 · Cabin class — every segment, not the first

An offer passes only if **all** segments on **all** slices are within the allowed set. A single
premium leg fails the whole offer.

This is not hypothetical: **191 of the 1,669 offers** in the economy fixture contain a
`premium_economy` segment despite the search specifying `cabin_class: economy`. Checking only the
first segment would let all 191 through. Duffel's `cabin_class` search parameter is a *preference*,
not a guarantee — the policy engine is what actually enforces it, which is a good line for the
writeup.

`observed` reports the **most premium** cabin found, ranked
`economy < premium_economy < business < first`. Unknown cabin values sort as most premium (fail
closed).

Per decision 6, fare class means `cabin_class`. **`fare_brand_name` is not used in v1** — it is
absent on ~1% of offers (14 of 1,513 in the 1 Aug pre-flight) while `cabin_class` is present on
100%. A v2 fare-brand rule must tolerate `null`.

### 2 · Vendor allowlist — `owner`, not marketing carrier

v1 matches `owner.iata_code` — the airline that owns the offer and issues the ticket. Marketing and
operating carriers on individual segments are **not** checked. On a codeshare these can differ from
the owner, so a strict corporate policy would want per-segment checks; that is a stated v1
limitation, not an oversight. In the captured fixture the three are identical for every offer.

### 3 · Advance purchase — date granularity, UTC, floored

`departing_at` is **local airport time with no offset** (`"2026-09-15T10:50:00"`). It cannot be
converted to an instant without a timezone database, and v1 does not ship one.

Therefore: compare **calendar dates only**.

```
daysUntilDeparture = utcDateOf(firstSegment.departing_at) - utcDateOf(now)   // whole days, floored
```

Take the first segment of the **first** slice (outbound departure). The return leg is irrelevant to
an advance-purchase rule.

Worst-case error is ±1 day from the timezone gap. At a 14-day threshold this is immaterial, and
being explicit about it beats a false-precision instant comparison. Say so if asked.

**This rule does not bite on either captured fixture** (all offers depart 51 days out from the
capture date). It will render as a visible *pass* in B2a and will not appear in a block. That is
expected — do not "fix" it by tuning the threshold to manufacture a failure.

### 4 · Budget cap — integer comparison

`toMinorUnits(offer.total_amount) <= policy.budgetCapMinor`. Inclusive. Zero tolerance, no epsilon
(decision 1). `detail` on failure carries the overage in minor units.

---

## Missing data — fail closed

If a required field is absent or unparseable, the rule **fails** with `observed: "unavailable"` and
the offer is not selectable. Specifically: no segments, empty `passengers`, unparseable
`departing_at`, malformed `total_amount`, missing `owner.iata_code`.

Rationale: the alternative — treating unknown as compliant — means a malformed offer can be
purchased. That inverts the product. It is also the correct answer to the Skyscanner-fallback gap
(decision 6): if a data source cannot express cabin class, every offer fails that rule loudly
rather than passing silently.

---

## Selection

Among offers where **all four rules pass**:

```
sort by (totalMinor ASC, id ASC)  →  selected = [0], runnerUp = [1] ?? null
```

Cheapest compliant wins (decision 7). `id` is the final tiebreak so two identically-priced offers
never reorder between runs. **`runnerUp` is recorded in the audit entry** — that is what makes
*"why this flight?"* answerable, and it is pillar 4 earned cheaply.

## Block path

When `compliant.length === 0`, the decision is `BLOCKED` and **no Prava session is created**.

Two distinct facts are reported. They are frequently different offers, and conflating them is the
mistake this section exists to prevent:

- **`nearestMiss`** — nearest to *compliance*: fewest failing rules, tiebreak smallest budget
  overage, then `id`. This is what "nearest miss" means.
- **`cheapestOverall`** — the cheapest offer in the result set and its budget delta. Decision 3
  promises a price delta (*"cheapest available is $180 over your $1,200 cap"*), and the nearest
  miss is not necessarily the cheapest.

On the business fixture these genuinely diverge: nearest miss is **Iberia 8,213.56** failing
exactly 2 rules (cabin, budget), while the cheapest is **Asiana 7,104.08** failing 3 (cabin,
budget, vendor — Asiana is off the allowlist). Reporting only the cheapest would claim a 3-rule
failure is "nearest"; reporting only the nearest miss would drop the price delta that decision 3
promised. Report both, labelled.

Per decision 3, the engine **never** proposes a compliant alternative on the blocked path — by
definition none exists in the result set.

---

## Output types

Shaped to render directly into `ui-layout.md` columns B and C with no transformation.

```ts
type RuleId = 'cabin_class' | 'vendor_allowlist' | 'advance_purchase' | 'budget_cap';

type RuleResult = {
  rule: RuleId;
  passed: boolean;
  observed: string;   // "business"            "7104.08 AUD"        "50 days"      "OZ"
  expected: string;   // "economy only"        "<= 1300.00 AUD"     ">= 14 days"   "on allowlist"
  detail?: string;    // "over by 5804.08 AUD"
};

type OfferEvaluation = {
  offerId: string;
  totalMinor: number;
  totalAmount: string;      // ORIGINAL string — this is what becomes the mandate amount
  currency: string;
  carrier: { iata: string; name: string };
  rules: RuleResult[];      // always length 4, always in display order
  compliant: boolean;       // every rule passed
  failedRules: RuleId[];
};

type PolicyDecision = {
  outcome: 'APPROVED' | 'BLOCKED';
  policyVersion: string;
  evaluatedAt: string;              // ISO, from injected `now`
  totalOffers: number;
  funnel: Array<{ rule: RuleId; remaining: number }>;   // cumulative, display order
  selected: OfferEvaluation | null;
  runnerUp: OfferEvaluation | null;
  nearestMiss: OfferEvaluation | null;      // BLOCKED only
  cheapestOverall: OfferEvaluation | null;  // BLOCKED only
};
```

`funnel` is **cumulative** — each entry is how many offers survive rules 1..n. It drives the B1
ticker.

---

## Golden test vectors

Computed from the captured fixtures. **These are the acceptance criteria** — an implementation that
does not reproduce them exactly is wrong. Read fixtures with `encoding='utf-8-sig'` (UTF-8 BOM).

Policy: cap `130000`, cabins `["economy"]`, `minAdvanceDays: 14`, allowlist
`["ZZ","IB","BA","AA","SQ","LH","QR","EY","NH","JL","TG","AI"]`, `now = 2026-07-26`.

Offers are pre-filtered to the **hold-eligible** ones (see "Discovery filter" below) before the
funnel is computed.

### APPROVED — `logs/duffel/01-offer_requests-POST.full.json.zip` (1,669 offers)

```
1669 offers → 638 bookable
funnel:  638 → cabin 638 → vendor 503 → advance 503 → budget 4
selected:  Duffel Airways (ZZ)     1202.75 AUD
runnerUp:  Iberia (IB)             1231.32 AUD
also compliant: British Airways 1231.46, American Airlines 1256.25
```

The trimmed `01-offer_requests-POST.json` (32 offers → 30 bookable, funnel 30 → 30 → 18 → 18 → 4)
must produce the **same selected and runner-up**. Test both.

### BLOCKED — `logs/duffel/08-offer_requests-BLOCKED-business.json` (31 offers)

```
31 offers → 29 bookable
funnel:  29 → cabin 0 → vendor 0 → advance 0 → budget 0
compliant: none
nearestMiss:      Iberia 8213.56 AUD — fails [cabin_class, budget_cap], over by 6913.56
cheapestOverall:  Asiana 7104.08 AUD — fails [cabin_class, vendor_allowlist, budget_cap]
```

### Unit-level

| Input | Expected |
|---|---|
| `toMinorUnits("1202.75")` | `120275` |
| `toMinorUnits("1203")` | `120300` |
| `toMinorUnits("1203.5")` | `120350` |
| `toMinorUnits("1,203.50")` | throws |
| offer with one `premium_economy` segment, rest economy | `cabin_class` **fails** |
| offer with `total_currency: "USD"`, policy `AUD` | excluded, `currency_mismatch` |
| offer with `segments: []` | all evaluable rules fail; not selectable |

---

## Known limitations — state these before a judge finds them

- Vendor allowlist checks the **owner** only, not per-segment marketing/operating carriers.
- Advance purchase is **date-granular**, ±1 day at timezone boundaries.
- No currency conversion; cross-currency offers are excluded rather than compared.
- `fare_brand_name` (Basic vs Flex) is not evaluated in v1.
- No exception/override path (decision 9) — declared out of scope, shown on screen in column A.

## Note for the UI build (step 6)

`ui-layout.md`'s B1 ticker shows illustrative numbers (`1,669 → 214 → 47 → 3`). **The real funnel
is `1669 → 1478 → 1343 → 1343 → 4`.** Render computed values; do not hard-code either set. Same
applies to carrier names and prices, which move between live searches — three pre-event runs
produced three different cheapest/runner-up pairs.
