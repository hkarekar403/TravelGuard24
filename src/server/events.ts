/**
 * Progress events for the UI.
 *
 * The orchestrator knows nothing about any of this. Its ports are wrapped, and the wrappers
 * emit — the same technique the rehearsal uses to open Chrome. That keeps the judged code
 * path free of presentation concerns, and means the UI cannot change booking behaviour.
 */

import type { PolicyDecision } from '../policy/types.js';
import type {
  AuditEventType,
  DuffelPort,
  MerchantPort,
  PravaPort,
  RedemptionResult,
  AuditPort,
} from '../orchestrator/ports.js';

export type UiEvent =
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
      return inner.createHoldOrder(offerId, passenger, metadata);
    },
    async payFromBalance(orderId, amount, currency) {
      emit({ type: 'settling' });
      return inner.payFromBalance(orderId, amount, currency);
    },
    getOrder: (id) => inner.getOrder(id),
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
  return {
    append(type, payload) {
      const entry = inner.append(type, payload);
      emit({
        type: 'audit',
        seq: entry.seq,
        at: new Date().toISOString(),
        event: type,
        hash: entry.hash,
        prevHash: '',
      });
      return entry;
    },
  };
}
