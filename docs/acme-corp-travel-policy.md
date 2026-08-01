# Acme Corp — Corporate Air Travel Policy

**Document ID:** ACME-TRV-001 · **Version:** 1.4 · **Effective:** 1 July 2026
**Owner:** Finance Operations · **Approved by:** CFO
**Applies to:** all employees and contractors booking air travel on company funds.

This document is the authoritative statement of Acme Corp's air travel rules. Where an
automated booking tool enforces these rules, this document — not the tool's configuration —
is the source of record.

---

## 1. Budget cap

**The maximum permitted total price for a single air booking is AUD 1,300.00.**

The cap applies to the total ticketed amount including taxes, carrier charges and
checked baggage where bundled into the fare. It is a per-booking cap, not per-sector and
not per-trip. Bookings priced in a currency other than AUD are out of scope of this
version and must be handled manually.

## 2. Cabin class

**Economy is the only permitted cabin class.**

Premium economy, business and first class are not approved under this version of the
policy, irrespective of flight duration or route. Any itinerary containing a segment in a
cabin above economy fails this rule in full — a single premium segment is sufficient to
make the itinerary non-compliant.

## 3. Advance purchase

**Bookings must be made at least 14 days before the outbound departure date.**

Advance purchase is measured in whole days from the date of booking to the date of the
first outbound departure. Bookings made inside 14 days require an exception, and no
exception path exists in this version of the policy.

## 4. Approved carriers

Travel must be booked with a carrier on the approved list below. Approval is on the basis
of corporate agreements and safety audit status, reviewed annually by Finance Operations.

| IATA | Carrier |
|---|---|
| ZZ | Duffel Airways |
| IB | Iberia |
| BA | British Airways |
| AA | American Airlines |
| SQ | Singapore Airlines |
| LH | Lufthansa |
| QR | Qatar Airways |
| EY | Etihad Airways |
| NH | ANA |
| JL | Japan Airlines |
| TG | Thai Airways |
| AI | Air India |

The carrier is assessed as the offer's owning carrier. Codeshare operating carriers are
not separately assessed under this version.

---

## 5. Machine-readable summary

The following is the canonical machine-readable form of the rules stated above. It is
provided so that automated tooling reads the same values a human reader would.

```json
{
  "currency": "AUD",
  "budgetCapMinor": 130000,
  "allowedCabinClasses": ["economy"],
  "minAdvanceDays": 14,
  "vendorAllowlist": ["ZZ", "IB", "BA", "AA", "SQ", "LH", "QR", "EY", "NH", "JL", "TG", "AI"]
}
```

`budgetCapMinor` is expressed in minor units: 130000 is AUD 1,300.00.

---

## 6. Exceptions

**There is no exception or override path in version 1.4.** A booking that fails any rule
above is declined. Re-submission with relaxed constraints is not permitted without a
revision to this document approved by the CFO.
