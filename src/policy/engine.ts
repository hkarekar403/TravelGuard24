/**
 * The policy gate.
 *
 * Decides WHETHER a purchase should happen and WHICH offer — before any payment session
 * exists. Prava's guardrails bound a mandate that already exists; this decides which
 * mandate should exist at all. The two compose; they do not overlap.
 *
 * Implements `docs/policy-engine.md`. That document is the contract, including the golden
 * vectors the tests assert. Pure: no I/O, no clock, `now` injected.
 */

import { formatMinorUnits, MalformedAmountError, toMinorUnits } from '../money.js';
import {
  RULE_ORDER,
  type Offer,
  type OfferEvaluation,
  type Policy,
  type PolicyDecision,
  type RuleId,
  type RuleResult,
} from './types.js';

/**
 * Cabin ranking, least to most premium. An unrecognised value sorts as MOST premium so an
 * unknown cabin can never pass an "economy only" policy — fail closed.
 */
const CABIN_RANK: Record<string, number> = {
  economy: 0,
  premium_economy: 1,
  business: 2,
  first: 3,
};
const UNKNOWN_CABIN_RANK = 99;

const rank = (cabin: string): number => CABIN_RANK[cabin] ?? UNKNOWN_CABIN_RANK;

/** Whole days between two ISO dates, floored, compared as UTC calendar dates. */
function daysBetweenDates(fromISODate: string, toISODate: string): number | null {
  const from = Date.parse(`${fromISODate}T00:00:00Z`);
  const to = Date.parse(`${toISODate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

function allCabins(offer: Offer): string[] {
  return offer.slices.flatMap((s) => s.segments.flatMap((g) => g.passengers.map((p) => p.cabin_class)));
}

/** Most premium cabin on the offer, for display. Null when the offer carries none. */
function highestCabin(offer: Offer): string | null {
  const cabins = allCabins(offer).filter((c) => typeof c === 'string' && c.length > 0);
  if (cabins.length === 0) return null;
  return cabins.reduce((worst, c) => (rank(c) > rank(worst) ? c : worst));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function cabinRule(offer: Offer, policy: Policy): RuleResult {
  const expected = `${policy.allowedCabinClasses.join(' or ')} only`;
  const cabins = allCabins(offer);
  const observed = highestCabin(offer);

  // No cabin data at all — cannot evaluate, so it fails. Never assume compliance.
  if (observed === null || cabins.length === 0) {
    return { rule: 'cabin_class', passed: false, observed: 'unavailable', expected };
  }

  // EVERY segment must comply. Checking only the first would admit mixed-cabin
  // itineraries — 191 of 1,669 offers in an *economy* search carry a premium segment,
  // because Duffel's cabin_class search parameter is a preference, not a guarantee.
  const passed = cabins.every((c) => policy.allowedCabinClasses.includes(c));
  const mixed = new Set(cabins).size > 1;

  return {
    rule: 'cabin_class',
    passed,
    observed,
    expected,
    ...(passed ? {} : { detail: mixed ? `mixed cabins: ${[...new Set(cabins)].join(', ')}` : `policy allows ${expected}` }),
  };
}

function vendorRule(offer: Offer, policy: Policy): RuleResult {
  const iata = offer.owner?.iata_code;
  const expected = 'on allowlist';
  if (!iata) {
    return { rule: 'vendor_allowlist', passed: false, observed: 'unavailable', expected };
  }
  const passed = policy.vendorAllowlist.includes(iata);
  return {
    rule: 'vendor_allowlist',
    passed,
    observed: iata,
    expected,
    ...(passed ? {} : { detail: `${offer.owner.name} not an approved carrier` }),
  };
}

function advanceRule(offer: Offer, policy: Policy, now: Date): RuleResult {
  const expected = `>= ${policy.minAdvanceDays} days`;
  // Outbound departure only — the return leg is irrelevant to advance purchase.
  const departingAt = offer.slices[0]?.segments[0]?.departing_at;

  // `departing_at` is LOCAL airport time with no offset, so it cannot be made an instant
  // without a timezone database. Compare calendar dates and accept +/-1 day, rather than
  // implying a precision we do not have.
  const days = departingAt ? daysBetweenDates(now.toISOString().slice(0, 10), departingAt.slice(0, 10)) : null;

  if (days === null) {
    return { rule: 'advance_purchase', passed: false, observed: 'unavailable', expected };
  }
  const passed = days >= policy.minAdvanceDays;
  return {
    rule: 'advance_purchase',
    passed,
    observed: `${days} days`,
    expected,
    ...(passed ? {} : { detail: `${policy.minAdvanceDays - days} days short` }),
  };
}

function budgetRule(offer: Offer, policy: Policy): RuleResult {
  const expected = `<= ${formatMinorUnits(policy.budgetCapMinor)} ${policy.currency}`;
  let minor: number;
  try {
    minor = toMinorUnits(offer.total_amount);
  } catch (err) {
    if (!(err instanceof MalformedAmountError)) throw err;
    return { rule: 'budget_cap', passed: false, observed: 'unavailable', expected };
  }
  const passed = minor <= policy.budgetCapMinor;
  return {
    rule: 'budget_cap',
    passed,
    observed: `${offer.total_amount} ${offer.total_currency}`,
    expected,
    ...(passed ? {} : { detail: `over by ${formatMinorUnits(minor - policy.budgetCapMinor)} ${policy.currency}` }),
  };
}

// ---------------------------------------------------------------------------

function evaluateOffer(offer: Offer, policy: Policy, now: Date): OfferEvaluation {
  let totalMinor = Number.POSITIVE_INFINITY;
  try {
    totalMinor = toMinorUnits(offer.total_amount);
  } catch {
    /* left as Infinity: sorts last, and budgetRule reports it as unavailable */
  }

  const base = {
    offerId: offer.id,
    totalMinor,
    totalAmount: offer.total_amount,
    currency: offer.total_currency,
    carrier: { iata: offer.owner?.iata_code ?? '', name: offer.owner?.name ?? 'unknown' },
  };

  // A currency we cannot compare is an evaluation failure, not a budget failure. There is
  // no FX in v1, and comparing unlike numbers would be worse than refusing.
  if (offer.total_currency !== policy.currency) {
    const rules: RuleResult[] = RULE_ORDER.map((rule) => ({
      rule,
      passed: false,
      observed: offer.total_currency,
      expected: policy.currency,
      detail: 'currency mismatch — not comparable',
    }));
    return { ...base, rules, compliant: false, failedRules: [...RULE_ORDER], excluded: 'currency_mismatch' };
  }

  const rules: RuleResult[] = [
    cabinRule(offer, policy),
    vendorRule(offer, policy),
    advanceRule(offer, policy, now),
    budgetRule(offer, policy),
  ];

  const failedRules = rules.filter((r) => !r.passed).map((r) => r.rule);
  return { ...base, rules, compliant: failedRules.length === 0, failedRules };
}

/** Cheapest first, `offerId` as the final tiebreak so ordering is reproducible. */
const byPriceThenId = (a: OfferEvaluation, b: OfferEvaluation): number =>
  a.totalMinor - b.totalMinor || (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0);

export function evaluate(offers: Offer[], policy: Policy, now: Date): PolicyDecision {
  const evaluations = offers.map((o) => evaluateOffer(o, policy, now));

  // Cumulative funnel in display order: survivors after rules 1..n. Drives the UI ticker.
  const funnel = RULE_ORDER.map((rule, i) => {
    const upTo = RULE_ORDER.slice(0, i + 1);
    return {
      rule,
      remaining: evaluations.filter((e) => upTo.every((r) => e.rules.find((x) => x.rule === r)?.passed)).length,
    };
  });

  const compliant = evaluations.filter((e) => e.compliant).sort(byPriceThenId);

  if (compliant.length > 0) {
    return {
      outcome: 'APPROVED',
      policyVersion: policy.version,
      evaluatedAt: now.toISOString(),
      totalOffers: offers.length,
      funnel,
      compliant,
      selected: compliant[0] ?? null,
      runnerUp: compliant[1] ?? null,
      nearestMiss: null,
      cheapestOverall: null,
    };
  }

  // BLOCKED. Two distinct facts, and they are usually different offers:
  //  - nearestMiss     : nearest to COMPLIANCE (fewest failing rules)
  //  - cheapestOverall : the price delta decision 3 promised
  // Reporting only the cheapest would call a three-rule failure "nearest"; reporting only
  // the nearest miss would drop the delta.
  const overage = (e: OfferEvaluation): number =>
    Number.isFinite(e.totalMinor) ? Math.max(0, e.totalMinor - policy.budgetCapMinor) : Number.POSITIVE_INFINITY;

  const nearestMiss =
    [...evaluations].sort(
      (a, b) =>
        a.failedRules.length - b.failedRules.length ||
        overage(a) - overage(b) ||
        (a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0),
    )[0] ?? null;

  const cheapestOverall = [...evaluations].sort(byPriceThenId)[0] ?? null;

  return {
    outcome: 'BLOCKED',
    policyVersion: policy.version,
    evaluatedAt: now.toISOString(),
    totalOffers: offers.length,
    funnel,
    compliant: [],
    selected: null,
    runnerUp: null,
    nearestMiss,
    cheapestOverall,
  };
}
