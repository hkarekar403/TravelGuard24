# The travel policy — the human input

The engine enforces rules. **What those rules say is a business decision, not an engineering one.**
This file is where that decision gets made and written down.

`policy.json` is the machine-readable form. It is **data, not code** — a judge asking *"can it
express a different policy?"* gets a file, not a rebuild.

---

## The four factors in v1

Each row needs a human answer. Defaults below are what the demo currently uses; they were chosen
against real captured inventory, so changing them means re-checking that the demo still has both a
compliant result and a blocked one.

| # | Factor | Field | Current value | The decision to make |
|---|---|---|---|---|
| 1 | **Budget cap** | `budgetCapMinor` | AUD 1,300.00 | Per booking, or per trip? One cap, or per-route/per-region? Does it include taxes and bags? |
| 2 | **Cabin class** | `allowedCabinClasses` | `["economy"]` | Is premium economy allowed above some flight duration? Most real policies say yes over ~8h. |
| 3 | **Advance purchase** | `minAdvanceDays` | 14 | How many days before departure must a booking be made? |
| 4 | **Vendor allowlist** | `vendorAllowlist` | 12 IATA codes | Which carriers are approved, and on what basis — safety, corporate deal, alliance? |

### ⚠ Constraints the numbers must satisfy

**Do not change the cap without re-checking both demo scenarios.** At **1,300** the captured economy
search yields **4 compliant offers** with a clean gap to the next at 1,812.91. At **1,200** *nothing*
is compliant and the demo has no happy path at all. Verified three times against live inventory.

**Carrier names and prices move between searches.** Three consecutive live searches produced three
different cheapest/runner-up pairs. The allowlist must not be so narrow that a normal search yields
zero compliant offers — keep the major carriers in it.

---

## Decisions already made, and why

These are settled; they are here so they are not silently reopened.

- **"Fare class" means `cabin_class`**, not fare brand (Basic/Flex). Cabin is present on 100% of
  offers; `fare_brand_name` is missing on ~1%. Fare brand is a v2 refinement.
- **"Booking window" means advance purchase** — how far ahead the booking is made. The other
  reading (approval windows for travel dates) is an approval-workflow feature, out of scope.
- **The cap gates the decision; it never becomes the mandate amount.** The approved offer's exact
  price is what gets network-locked. Sending the cap would mint a credential spendable above what
  was approved — weaker than a plain checkout.
- **Cheapest compliant wins, and the runner-up is recorded**, so "why this flight?" is answerable.
- **No exception/override path in v1.** Real corporate policy has one. Declared out of scope
  explicitly rather than pretended away.

---

## Questions worth answering before the writeup

These are the ones a judge is most likely to ask. Answers do not need to be *implemented* — they
need to be *decided*.

1. **Who sets the policy?** Finance, the traveller's manager, or an ops team? This determines
   whether an override path is a gap or a deliberate exclusion.
2. **What happens when nothing is compliant?** v1 blocks and shows the nearest miss plus the price
   delta. The alternatives — re-search with relaxed constraints, or escalate for approval — are both
   whole features. Say which one is next.
3. **Does the policy differ by traveller?** Grade-based caps (exec vs. staff) are the most common
   real-world variation and would be the most credible v2 line.
4. **What about the return leg and multi-city?** The advance-purchase rule uses the outbound
   departure only.
5. **Airline-initiated changes.** If a carrier reschedules a booked flight, the new itinerary may no
   longer satisfy policy. Re-running the gate on `order.airline_initiated_change_detected` is the
   strongest "where this goes next" beat available and costs nothing to say.

---

## Not in v1 — say so rather than let it be discovered

Hotels · car hire · multi-passenger bookings · per-traveller policy · grade-based caps ·
exception approval workflow · re-search with relaxed constraints · fare-brand rules ·
per-segment carrier checks (the allowlist matches the offer owner, not codeshare operators) ·
currency conversion (a non-AUD offer is excluded, not converted).
