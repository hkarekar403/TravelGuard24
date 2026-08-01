/**
 * Policy engine contract. See `docs/policy-engine.md` — that document is authoritative;
 * this file is its type-level expression.
 *
 * Implementations must be PURE: no I/O, no clock reads, no network. `now` is injected.
 */

// ---------------------------------------------------------------------------
// Duffel offer — only the fields the policy engine actually consumes.
// ---------------------------------------------------------------------------

export type Carrier = {
  iata_code: string;
  name: string;
};

export type Segment = {
  /** LOCAL airport time, no UTC offset: "2026-09-15T10:50:00". Compare dates only. */
  departing_at: string;
  marketing_carrier: Carrier;
  operating_carrier: Carrier;
  passengers: Array<{ cabin_class: string }>;
};

export type Slice = {
  /** Absent on ~1% of offers. Not evaluated in v1. */
  fare_brand_name: string | null;
  segments: Segment[];
};

export type Offer = {
  id: string;
  /** Decimal string, e.g. "1202.75". Never parse to float for comparison. */
  total_amount: string;
  total_currency: string;
  expires_at: string;
  owner: Carrier;
  slices: Slice[];
};

// ---------------------------------------------------------------------------
// Policy — data, not code. Loaded from JSON.
// ---------------------------------------------------------------------------

export type Policy = {
  version: string;
  org: string;
  currency: string;
  /** Minor units. 130000 === AUD 1,300.00 */
  budgetCapMinor: number;
  allowedCabinClasses: string[];
  minAdvanceDays: number;
  /** IATA codes of approved carriers. */
  vendorAllowlist: string[];
};

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Evaluation order is also display order and funnel order. */
export const RULE_ORDER = [
  'cabin_class',
  'vendor_allowlist',
  'advance_purchase',
  'budget_cap',
] as const;

export type RuleId = (typeof RULE_ORDER)[number];

export type RuleResult = {
  rule: RuleId;
  passed: boolean;
  /** Human-readable actual value: "business", "7104.08 AUD", "50 days", "OZ". */
  observed: string;
  /** Human-readable requirement: "economy only", "<= 1300.00 AUD". */
  expected: string;
  /** Failure amplification, e.g. "over by 5804.08 AUD". */
  detail?: string;
};

export type ExclusionReason = 'currency_mismatch' | 'malformed_offer';

export type OfferEvaluation = {
  offerId: string;
  totalMinor: number;
  /**
   * The ORIGINAL amount string, untouched. This is what becomes the Prava mandate
   * amount — decision 1 requires an exact match, so it must never round-trip a float.
   */
  totalAmount: string;
  currency: string;
  carrier: { iata: string; name: string };
  /** Always length 4, always in RULE_ORDER. */
  rules: RuleResult[];
  compliant: boolean;
  failedRules: RuleId[];
  /** Set when the offer could not be evaluated at all; never selectable. */
  excluded?: ExclusionReason;
};

export type FunnelStep = {
  rule: RuleId;
  /** Cumulative survivors after rules 1..n. */
  remaining: number;
};

export type PolicyDecision = {
  outcome: 'APPROVED' | 'BLOCKED';
  policyVersion: string;
  /** ISO timestamp derived from the injected `now`. */
  evaluatedAt: string;
  totalOffers: number;
  funnel: FunnelStep[];
  /** Cheapest compliant offer. Null when BLOCKED. */
  selected: OfferEvaluation | null;
  /** Second-cheapest compliant. Recorded in the audit entry — answers "why this flight?". */
  runnerUp: OfferEvaluation | null;
  /** BLOCKED only: fewest failing rules. Nearest to COMPLIANCE. */
  nearestMiss: OfferEvaluation | null;
  /** BLOCKED only: cheapest in the result set. Usually a different offer to nearestMiss. */
  cheapestOverall: OfferEvaluation | null;
};

// ---------------------------------------------------------------------------
// Functions the implementation must provide
// ---------------------------------------------------------------------------

/** "1202.75" -> 120275. Throws on malformed input (fail closed). */
export type ToMinorUnits = (amount: string) => number;

/** The gate. Pure. `now` is injected so results are deterministic and testable. */
export type Evaluate = (
  offers: Offer[],
  policy: Policy,
  now: Date,
) => PolicyDecision;
