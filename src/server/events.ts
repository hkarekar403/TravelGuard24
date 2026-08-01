/**
 * Progress events for the UI.
 *
 * The orchestrator knows nothing about any of this. Its ports are wrapped, and the wrappers
 * emit — the same technique the rehearsal uses to open Chrome. That keeps the judged code
 * path free of presentation concerns, and means the UI cannot change booking behaviour.
 */

import type { Evaluate, PolicyDecision } from '../policy/types.js';
import type { TripIntent } from '../agent/intent.js';
import type { ChannelKind, InboundRequest } from '../channel/types.js';
import type {
  AuditEventType,
  DuffelPort,
  MerchantPort,
  PravaPort,
  RedemptionResult,
  AuditPort,
  SearchRequest,
} from '../orchestrator/ports.js';

export type UiEvent =
  | { type: 'arrived'; request: InboundRequest }
  | {
      type: 'replied';
      channel: ChannelKind;
      to: string;
      text: string;
      delivered: boolean;
      error?: string;
    }
  | { type: 'instructed'; text: string }
  | { type: 'understood'; intent: TripIntent }
  | { type: 'searching'; query: SearchRequest }
  | { type: 'searched'; offers: number; carriers: number; ms: number }
  | { type: 'decided'; decision: PolicyDecision }
  | { type: 'holding'; carrier: string; amount: string; currency: string }
  | { type: 'held'; pnr: string; carrier: string; amount: string; currency: string }
  | { type: 'hold_refused'; carrier: string; reason: string }
  | { type: 'awaiting_passkey'; amount: string; currency: string; iframeUrl: string; expiresAt: string }
  | { type: 'redeemed'; redemption: RedemptionResult }
  | { type: 'reported'; status: 'APPROVED' | 'DECLINED'; confirmed: boolean; visaConfirmation: string }
  | { type: 'settling' }
  | { type: 'ticketed'; pnr: string; eTicketNumber: string | null }
  | { type: 'audit'; seq: number; at: string; event: AuditEventType; hash: string; prevHash: string }
  | { type: 'finished'; status: string; detail?: unknown };

export type Emit = (event: UiEvent) => void;

/**
 * Wraps the Duffel port so search and hold progress reach the screen.
 *
 * The port deals in offer IDs, but a screen showing `off_0000B9…` when an airline
 * refuses a hold tells a viewer nothing. So the offers seen going past are remembered
 * here and the ID is resolved back to a carrier on the way out. Presentation detail,
 * kept out of the orchestrator and out of the port contract.
 */
export function instrumentDuffel(inner: DuffelPort, emit: Emit): DuffelPort {
  const seen = new Map<string, { carrier: string; amount: string; currency: string }>();
  const describe = (offerId: string) =>
    seen.get(offerId) ?? { carrier: offerId, amount: '', currency: '' };

  return {
    async search(req) {
      emit({ type: 'searching', query: req });
      const startedAt = Date.now();
      const offers = await inner.search(req);
      for (const o of offers) {
        seen.set(o.id, { carrier: o.owner.name, amount: o.total_amount, currency: o.total_currency });
      }
      emit({
        type: 'searched',
        offers: offers.length,
        carriers: new Set(offers.map((o) => o.owner.iata_code)).size,
        ms: Date.now() - startedAt,
      });
      return offers;
    },
    async refreshOffer(id) {
      const offer = await inner.refreshOffer(id);
      // Re-quoting can move the price. Keep the map on the current number so the hold
      // step shows what is actually about to be committed.
      seen.set(offer.id, {
        carrier: offer.owner.name,
        amount: offer.total_amount,
        currency: offer.total_currency,
      });
      return offer;
    },
    async createHoldOrder(offerId, passenger, metadata) {
      const { carrier, amount, currency } = describe(offerId);
      emit({ type: 'holding', carrier, amount, currency });
      try {
        const order = await inner.createHoldOrder(offerId, passenger, metadata);
        emit({
          type: 'held',
          pnr: order.bookingReference,
          carrier,
          amount: order.totalAmount,
          currency: order.totalCurrency,
        });
        return order;
      } catch (err) {
        // Some airlines refuse holds with `422 invalid_order_create_type`, and nothing
        // in the offer says which will. The orchestrator falls through to the next
        // compliant offer — every one of which the policy already approved — so this is
        // a step in the journey, not an error. The screen has to say so, otherwise the
        // fallback looks like a stall or, worse, like the gate being retried.
        emit({ type: 'hold_refused', carrier, reason: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    async payFromBalance(orderId, amount, currency) {
      emit({ type: 'settling' });
      return inner.payFromBalance(orderId, amount, currency);
    },
    getOrder: (id) => inner.getOrder(id),
  };
}

/**
 * Wraps the policy gate so the decision reaches the screen the moment it is made.
 *
 * This one matters more than the others: without it the decision only surfaces after the
 * booking finishes, which would show the policy check AFTER the payment. The gate running
 * BEFORE any mandate exists is the entire product, so the ordering on screen has to match
 * the ordering in the code.
 */
export function instrumentEvaluate(inner: Evaluate, emit: Emit): Evaluate {
  return (offers, policy, now) => {
    const decision = inner(offers, policy, now);
    emit({ type: 'decided', decision });
    return decision;
  };
}

/** Wraps Prava so the passkey step becomes a screen state rather than a silent wait. */
export function instrumentPrava(inner: PravaPort, emit: Emit): PravaPort {
  return {
    async createSession(req) {
      const session = await inner.createSession(req);
      emit({
        type: 'awaiting_passkey',
        amount: req.totalAmount,
        currency: req.currency,
        iframeUrl: session.iframeUrl,
        expiresAt: session.expiresAt,
      });
      return session;
    },
    getPaymentResult: (id) => inner.getPaymentResult(id),
    // What we told the network, and what it said back. The confirmed screen used to
    // assert `visa_confirmation SUCCESS` in markup; on a screen whose whole claim is
    // evidence rather than assertion, that value has to come from the response.
    async reportStatus(id, cred, status) {
      const report = await inner.reportStatus(id, cred, status);
      emit({
        type: 'reported',
        status,
        confirmed: report.confirmed,
        visaConfirmation: report.visaConfirmation,
      });
      return report;
    },
  };
}

/** Wraps the merchant so the three guardrail checks can be revealed one at a time. */
export function instrumentMerchant(inner: MerchantPort, emit: Emit): MerchantPort {
  return {
    redeem(credential, expected) {
      const redemption = inner.redeem(credential, expected);
      emit({ type: 'redeemed', redemption });
      return redemption;
    },
  };
}

/** Mirrors every audit entry to the screen, including the ones written on a block. */
export function instrumentAudit(inner: AuditPort, emit: Emit): AuditPort {
  // AuditPort.append returns only { seq, hash }, so the link is tracked here. The chain
  // arrow is what makes the hash chain self-evident on screen rather than asserted.
  let prevHash = '';
  return {
    append(type, payload) {
      const entry = inner.append(type, payload);
      emit({
        type: 'audit',
        seq: entry.seq,
        at: new Date().toISOString(),
        event: type,
        hash: entry.hash,
        prevHash,
      });
      prevHash = entry.hash;
      return entry;
    },
  };
}

/**
 * Demo affordance: deliberately corrupts what is presented to the merchant so the
 * guardrail can be seen to bite.
 *
 * Labelled in the UI and applied to the PRESENTATION, never to the checks themselves —
 * faking a rejection by weakening the validator would prove nothing. The judge sees the
 * input being changed and the real check refusing it.
 */
export type TamperMode = 'none' | 'amount' | 'merchant' | 'replay';

export function applyTamper(inner: MerchantPort, mode: TamperMode): MerchantPort {
  if (mode === 'none') return inner;
  return {
    redeem(credential, expected) {
      if (mode === 'amount') {
        // An agent presenting more than the mandate authorised.
        return inner.redeem({ ...credential, totalAmount: '9999.00' }, expected);
      }
      if (mode === 'merchant') {
        return inner.redeem({ ...credential, merchantName: 'Definitely Not TravelGuard24' }, expected);
      }
      // replay: present the same credential twice; the second must be refused.
      inner.redeem(credential, expected);
      return inner.redeem(credential, expected);
    },
  };
}
