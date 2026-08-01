/**
 * The orchestrator — TravelGuard24's core.
 *
 * It sequences one booking across two money legs and enforces the ordering between them.
 * The ordering IS the integration: remove Prava and leg 2 has no trigger at all.
 *
 *   Leg 1  traveller -> TravelGuard24   Prava credential, policy-capped mandate, passkey
 *   Leg 2  TravelGuard24 -> airline     Duffel `balance` agency settlement
 *
 * Four invariants. Every early return below exists to protect one of them.
 *
 *   I1  No Prava session is created unless the policy gate returned APPROVED.
 *       The gate runs BEFORE any mandate exists. This is the product.
 *
 *   I2  The mandate amount is the exact quoted price — never the policy budget cap.
 *       The cap gates the decision; the approved price becomes the network-locked amount.
 *
 *   I3  report-status is only sent as APPROVED after our own mandate enforcement passes.
 *
 *   I4  Leg 2 fires only if leg 1 completed. A declined passkey, a failed mandate check,
 *       or a non-APPROVED report-status means the airline is never paid and the hold
 *       simply expires.
 *
 * Every terminating path writes an audit entry, including the blocked ones. A refusal is
 * evidence, not a non-event.
 */

import type { Evaluate, OfferEvaluation, Policy, PolicyDecision } from '../policy/types.js';
import type {
  AuditPort,
  Clock,
  DuffelPort,
  MerchantPort,
  Passenger,
  PaymentCredential,
  PravaPort,
  RedemptionResult,
  SearchRequest,
} from './ports.js';

export type BookingRequest = {
  search: SearchRequest;
  passenger: Passenger;
  policy: Policy;
  userId: string;
  userEmail: string;
  /** Enrolled card to pre-select, avoiding a card-picker surprise mid-demo. */
  cardId: string;
};

export type Dependencies = {
  duffel: DuffelPort;
  prava: PravaPort;
  merchant: MerchantPort;
  audit: AuditPort;
  clock: Clock;
  evaluate: Evaluate;
};

export type BookingOutcome =
  | { status: 'BLOCKED_BY_POLICY'; decision: PolicyDecision }
  | { status: 'PRICE_DRIFTED'; quoted: string; ordered: string; pnr: string }
  | { status: 'NO_BOOKABLE_OFFER'; attempts: Array<{ offerId: string; carrier: string; error: string }> }
  | { status: 'AUTHORISATION_TIMED_OUT'; pnr: string; sessionId: string }
  | { status: 'AUTHORISATION_FAILED'; pnr: string; sessionId: string; pravaStatus: string }
  | { status: 'REDEMPTION_REJECTED'; pnr: string; sessionId: string; redemption: RedemptionResult }
  | { status: 'REPORT_REJECTED'; pnr: string; sessionId: string; visaConfirmation: string }
  | { status: 'SETTLEMENT_FAILED'; pnr: string; sessionId: string; error: string }
  | {
      status: 'CONFIRMED';
      pnr: string;
      sessionId: string;
      eTicketNumber: string | null;
      amount: string;
      currency: string;
      decision: PolicyDecision;
      redemption: RedemptionResult;
    };

/** How long to wait for the human passkey tap. Prava sessions expire in 15 minutes. */
const AUTH_POLL_INTERVAL_MS = 2_000;
const AUTH_TIMEOUT_MS = 14 * 60 * 1_000;

/**
 * Statuses that mean "credentials will never arrive". Anything else — including a status
 * we have never seen — is treated as keep-waiting. Prava's own docs disagree with
 * themselves about whether `processing` exists, so the loop must not enumerate.
 */
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'expired']);

export async function bookTrip(req: BookingRequest, deps: Dependencies): Promise<BookingOutcome> {
  const { duffel, prava, merchant, audit, clock, evaluate } = deps;

  // -- 1. Discover -----------------------------------------------------------
  const offers = await duffel.search(req.search);

  // -- 2. Gate ---------------------------------------------------------------
  // Pure, offline, no vendor involved. Runs before anything can be spent.
  const decision = evaluate(offers, req.policy, clock.now());

  if (decision.outcome === 'BLOCKED' || decision.selected === null) {
    // I1. Terminal. Prava is never called — there is nothing compliant to authorise,
    // and asking for a mandate we would have to refuse is worse than not asking.
    audit.append('POLICY_BLOCKED', {
      policyVersion: decision.policyVersion,
      totalOffers: decision.totalOffers,
      funnel: decision.funnel,
      nearestMiss: decision.nearestMiss,
      cheapestOverall: decision.cheapestOverall,
    });
    return { status: 'BLOCKED_BY_POLICY', decision };
  }

  const selected = decision.selected;
  audit.append('POLICY_APPROVED', {
    policyVersion: decision.policyVersion,
    offerId: selected.offerId,
    amount: selected.totalAmount,
    carrier: selected.carrier,
    rules: selected.rules,
    // Decision 7: recording the runner-up is what makes "why this flight?" answerable.
    runnerUp: decision.runnerUp && {
      offerId: decision.runnerUp.offerId,
      amount: decision.runnerUp.totalAmount,
      carrier: decision.runnerUp.carrier,
    },
  });

  // -- 3/4. Re-price and hold, falling back down the compliant list ----------
  //
  // Not every airline supports hold orders, and NOTHING in the offer advertises which
  // do: `requires_instant_payment` can be false and the hold still fails with
  // `422 invalid_order_create_type`. Since "cheapest compliant" lands on a different
  // carrier on every search, a single attempt makes the whole flow a coin flip.
  //
  // So we walk the compliant offers in policy order. Every candidate is one the policy
  // already approved, so falling back never weakens the decision — it only costs money,
  // and it costs the least possible extra.
  const candidates = decision.compliant.length > 0 ? decision.compliant : [selected];
  let held: { order: Awaited<ReturnType<DuffelPort['createHoldOrder']>>; offer: OfferEvaluation } | null = null;
  const holdAttempts: Array<{ offerId: string; carrier: string; error: string }> = [];

  for (const candidate of candidates) {
    // Offers expire ~30 minutes after creation. Re-quote immediately before committing
    // so the mandate is locked to a price that is still live (decision 1).
    const refreshed = await duffel.refreshOffer(candidate.offerId);

    let order: Awaited<ReturnType<DuffelPort['createHoldOrder']>>;
    try {
      // The PNR is assigned HERE, at zero payment. Payment later produces the e-ticket
      // document, not the booking reference — do not let the UI imply otherwise.
      order = await duffel.createHoldOrder(refreshed.id, req.passenger, {
        internal_booking_ref: `TG24-${decision.policyVersion}`,
        policy_decision_id: decision.evaluatedAt,
      });
    } catch (err) {
      holdAttempts.push({
        offerId: candidate.offerId,
        carrier: candidate.carrier.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // I2. The order total is what we are actually liable for. If it has moved away from
    // the quote the policy approved, the approved decision no longer describes this
    // purchase — stop rather than mint a mandate for a number nobody approved. This is
    // NOT a fallback case: a moving price is a reason to stop, not to shop.
    if (order.totalAmount !== refreshed.total_amount) {
      return {
        status: 'PRICE_DRIFTED',
        quoted: refreshed.total_amount,
        ordered: order.totalAmount,
        pnr: order.bookingReference,
      };
    }

    held = { order, offer: candidate };
    break;
  }

  if (held === null) {
    return { status: 'NO_BOOKABLE_OFFER', attempts: holdAttempts };
  }

  const order = held.order;

  audit.append('HOLD_CREATED', {
    pnr: order.bookingReference,
    orderId: order.id,
    amount: order.totalAmount,
    carrier: held.offer.carrier,
    paymentRequiredBy: order.paymentRequiredBy,
    // Recording the skipped carriers keeps "why not the cheapest?" answerable, which is
    // the same obligation the runner-up entry discharges for the policy decision.
    ...(holdAttempts.length > 0 ? { rejectedByAirline: holdAttempts } : {}),
  });

  // -- 5. Mandate ------------------------------------------------------------
  // I2 again, stated positively: the amount sent is the order total, verbatim as a
  // string. Never the policy cap, and never a float round-trip.
  const session = await prava.createSession({
    totalAmount: order.totalAmount,
    currency: order.totalCurrency,
    externalOrderRef: order.id,
    productId: order.bookingReference,
    // Rendered to the traveller on Prava's checkout and on Visa's authentication screen,
    // and it is the last thing they read before authorising. Naming the carrier lets them
    // check it against the fare the agent proposed; "Flight SYD-LHR return" alone is not
    // something anyone can verify. Uses the HELD carrier, which after a fallback is not
    // the one the gate first chose.
    description: `${held.offer.carrier.name} ${req.search.origin}-${req.search.destination} return, ${req.search.cabinClass}`,
    userId: req.userId,
    userEmail: req.userEmail,
    cardId: req.cardId,
  });

  audit.append('MANDATE_REQUESTED', {
    sessionId: session.sessionId,
    pnr: order.bookingReference,
    amount: order.totalAmount,
    currency: order.totalCurrency,
    expiresAt: session.expiresAt,
  });

  // -- 6. Authorise (human passkey) ------------------------------------------
  const authorised = await awaitCredentials(prava, clock, session.sessionId);

  if (authorised.kind === 'timeout') {
    // I4. No settlement. The hold expires on its own.
    return { status: 'AUTHORISATION_TIMED_OUT', pnr: order.bookingReference, sessionId: session.sessionId };
  }
  if (authorised.kind === 'failed') {
    return {
      status: 'AUTHORISATION_FAILED',
      pnr: order.bookingReference,
      sessionId: session.sessionId,
      pravaStatus: authorised.pravaStatus,
    };
  }

  const credential = authorised.credential;

  // -- 7. Redeem, enforcing the mandate --------------------------------------
  // Prava's guidance for sandbox is to simulate on a dummy store. This step does more:
  // it enforces the mandate it was issued under. Prava accepts a duplicate
  // report-status, so replay protection genuinely has to live here.
  const redemption = merchant.redeem(credential, {
    amount: order.totalAmount,
    currency: order.totalCurrency,
    merchantName: 'TravelGuard24',
  });

  if (!redemption.accepted) {
    // I3. Report the truth to the network, then stop. Reporting DECLINED closes the
    // mandate rather than leaving live credentials outstanding.
    await prava.reportStatus(session.sessionId, credential, 'DECLINED');
    audit.append('REDEMPTION_REJECTED', {
      sessionId: session.sessionId,
      pnr: order.bookingReference,
      checks: redemption.checks,
    });
    // I4. Airline is never paid.
    return { status: 'REDEMPTION_REJECTED', pnr: order.bookingReference, sessionId: session.sessionId, redemption };
  }

  // -- 8. Confirm to the network ---------------------------------------------
  const report = await prava.reportStatus(session.sessionId, credential, 'APPROVED');

  if (!report.confirmed) {
    return {
      status: 'REPORT_REJECTED',
      pnr: order.bookingReference,
      sessionId: session.sessionId,
      visaConfirmation: report.visaConfirmation,
    };
  }

  audit.append('PAYMENT_APPROVED', {
    sessionId: session.sessionId,
    pnr: order.bookingReference,
    txnRefId: credential.txnRefId,
    amount: order.totalAmount,
    visaConfirmation: report.visaConfirmation,
    // The PNR round-trips through Prava, joining the two legs without inventing a
    // correlation id of our own.
    externalProductId: credential.externalProductId,
    redemptionChecks: redemption.checks,
  });

  // -- 9. Settle (leg 2) -----------------------------------------------------
  // I4 discharged: this line is reachable only via a confirmed leg 1.
  try {
    await duffel.payFromBalance(order.id, order.totalAmount, order.totalCurrency);
  } catch (err) {
    // Leg 1 took the traveller's money and leg 2 failed, so the ticket will not issue.
    // v1 records it loudly for manual resolution; production would refund. Being
    // explicit about this beats pretending the ordering makes it impossible.
    const error = err instanceof Error ? err.message : String(err);
    audit.append('SETTLEMENT_FAILED', { sessionId: session.sessionId, pnr: order.bookingReference, error });
    return { status: 'SETTLEMENT_FAILED', pnr: order.bookingReference, sessionId: session.sessionId, error };
  }

  // -- 10. Confirm -----------------------------------------------------------
  const settled = await duffel.getOrder(order.id);
  const eTicket = settled.documents.find((d) => d.type === 'electronic_ticket') ?? null;

  audit.append('TICKET_ISSUED', {
    pnr: settled.bookingReference,
    eTicketNumber: eTicket?.uniqueIdentifier ?? null,
    paidAt: settled.paidAt,
  });

  return {
    status: 'CONFIRMED',
    pnr: settled.bookingReference,
    sessionId: session.sessionId,
    eTicketNumber: eTicket?.uniqueIdentifier ?? null,
    amount: order.totalAmount,
    currency: order.totalCurrency,
    decision,
    redemption,
  };
}

// ---------------------------------------------------------------------------

type AuthOutcome =
  | { kind: 'credentials'; credential: PaymentCredential }
  | { kind: 'timeout' }
  | { kind: 'failed'; pravaStatus: string };

/**
 * Poll until the passkey tap produces credentials.
 *
 * Two things this deliberately gets right:
 *  - It waits for the SESSION status `awaiting_result`, then reads credentials from the
 *    line item. The line item reports `credentials_generated`, never `awaiting_result` —
 *    waiting for the latter on a line item hangs forever.
 *  - Any unrecognised status counts as keep-waiting. Prava documents `processing` in one
 *    place and omits it from the enum in another; an allow-list would break on their
 *    next addition.
 */
async function awaitCredentials(prava: PravaPort, clock: Clock, sessionId: string): Promise<AuthOutcome> {
  const deadline = clock.now().getTime() + AUTH_TIMEOUT_MS;

  while (clock.now().getTime() < deadline) {
    const result = await prava.getPaymentResult(sessionId);

    if (result.credential !== null) {
      return { kind: 'credentials', credential: result.credential };
    }
    if (TERMINAL_FAILURE_STATUSES.has(result.status)) {
      return { kind: 'failed', pravaStatus: result.status };
    }

    await clock.sleep(AUTH_POLL_INTERVAL_MS);
  }

  return { kind: 'timeout' };
}
