/**
 * Progress events for the UI.
 *
 * The orchestrator knows nothing about any of this. Its ports are wrapped, and the wrappers
 * emit — the same technique the rehearsal uses to open Chrome. That keeps the judged code
 * path free of presentation concerns, and means the UI cannot change booking behaviour.
 */

import type { Evaluate, PolicyDecision } from '../policy/types.js';
import type { TripIntent } from '../agent/intent.js';
import type {
  AuditEventType,
  DuffelPort,
  MerchantPort,
  PravaPort,
  RedemptionResult,
  AuditPort,
} from '../orchestrator/ports.js';

export type UiEvent =
  | { type: 'instructed'; text: string }
  | { type: 'understood'; intent: TripIntent }
  | { type: 'searching' }
  | { type: 'searched'; offers: number; carriers: number }
  | { type: 'decided'; decision: PolicyDecision }
  | { type: 'holding' }
  | { type: 'held'; pnr: string; carrier: string; amount: string; currency: string }
  | { type: 'hold_refused'; carrier: string }
  | { type: 'awaiting_passkey'; amount: string; currency: string; iframeUrl: string; expiresAt: string }
  | { type: 'redeemed'; redemption: RedemptionResult }
  | { type: 'settling' }
  | { type: 'ticketed'; pnr: string; eTicketNumber: string | null }
  | { type: 'audit'; seq: number; at: string; event: AuditEventType; hash: string; prevHash: string }
  | { type: 'finished'; status: string; detail?: unknown };

export type Emit = (event: UiEvent) => void;

/** Wraps the Duffel port so search and hold progress reach the screen. */
export function instrumentDuffel(inner: DuffelPort, emit: Emit): DuffelPort {
  return {
    async search(req) {
      emit({ type: 'searching' });
      const offers = await inner.search(req);
      emit({
        type: 'searched',
        offers: offers.length,
        carriers: new Set(offers.map((o) => o.owner.iata_code)).size,
      });
      return offers;
    },
    refreshOffer: (id) => inner.refreshOffer(id),
    async createHoldOrder(offerId, passenger, metadata) {
      emit({ type: 'holding' });
      try {
        const order = await inner.createHoldOrder(offerId, passenger, metadata);
        emit({
          type: 'held',
          pnr: order.bookingReference,
          carrier: '',
          amount: order.totalAmount,
          currency: order.totalCurrency,
        });
        return order;
      } catch (err) {
        // Some airlines refuse holds. The orchestrator falls through to the next
        // compliant offer; the screen should show that rather than appear to stall.
        emit({ type: 'hold_refused', carrier: offerId });
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
    reportStatus: (id, cred, status) => inner.reportStatus(id, cred, status),
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
