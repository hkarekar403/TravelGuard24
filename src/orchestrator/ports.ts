/**
 * Ports the orchestrator depends on. Defined as interfaces so the gating logic can be
 * tested against fakes — the invariants in `orchestrator.ts` are the judged deliverable
 * and must be provable without touching a sandbox or spending Prava quota.
 */

import type { Offer } from '../policy/types.js';

// ---------------------------------------------------------------------------
// Duffel
// ---------------------------------------------------------------------------

export type SearchRequest = {
  origin: string;
  destination: string;
  departureDate: string; // YYYY-MM-DD
  returnDate: string;    // YYYY-MM-DD
  cabinClass: string;
};

export type Passenger = {
  title: string;
  givenName: string;
  familyName: string;
  bornOn: string;
  gender: string;
  phoneNumber: string;
  email: string;
};

export type HoldOrder = {
  id: string;
  /** PNR. Assigned HERE, at hold time — not by payment. */
  bookingReference: string;
  totalAmount: string;
  totalCurrency: string;
  awaitingPayment: boolean;
  paymentRequiredBy: string;
};

export type BalancePayment = {
  id: string;
  status: string;
};

export type OrderDocuments = {
  documents: Array<{ type: string; uniqueIdentifier: string }>;
  paidAt: string | null;
  awaitingPayment: boolean;
  bookingReference: string;
};

export interface DuffelPort {
  search(req: SearchRequest): Promise<Offer[]>;
  /** Decision 1: re-price immediately before creating the session. */
  refreshOffer(offerId: string): Promise<Offer>;
  createHoldOrder(offerId: string, passenger: Passenger, metadata: Record<string, string>): Promise<HoldOrder>;
  /** Agency-settlement leg. NEVER the card path. */
  payFromBalance(orderId: string, amount: string, currency: string): Promise<BalancePayment>;
  getOrder(orderId: string): Promise<OrderDocuments>;
}

// ---------------------------------------------------------------------------
// Prava
// ---------------------------------------------------------------------------

export type CreateSessionRequest = {
  /** MUST be the exact offer/order price. Never the policy budget cap (decision 1). */
  totalAmount: string;
  currency: string;
  externalOrderRef: string;
  /** The Duffel PNR. Echoes back as `external_product_id` — a free join key between legs. */
  productId: string;
  description: string;
  userId: string;
  userEmail: string;
  /**
   * OPT-IN card pre-selection, empty by default.
   *
   * An earlier version of this comment claimed it BREAKS the hosted checkout. That was
   * wrong: a control session sent WITHOUT the card object stalled on the same screen, so the
   * fault was elsewhere. See `prava/client.ts` for the full correction.
   *
   * Pre-selecting is what stops the checkout offering the customer's default card when that
   * is not the one you want used — which matters as soon as a customer has more than one.
   */
  cardId: string;
};

export type PravaSession = {
  sessionId: string;
  orderId: string;
  iframeUrl: string;
  expiresAt: string;
};

/**
 * Credentials live at transactions[].line_items[] — NOT top-level — and are present only
 * while the session is `awaiting_result`. They are gone after report-status.
 */
export type PaymentCredential = {
  txnRefId: string;
  /** Required by report-status alongside txn_ref_id. Lives on products[], not the line item. */
  productRefId: string;
  merchantName: string;
  merchantUrl: string;
  totalAmount: string;
  token: string;
  /** The one-time value. The token is STABLE per card — never dedupe on the token. */
  dynamicCvv: string;
  expiryMonth: string;
  expiryYear: string;
  externalProductId: string | null;
};

export type PaymentResult = {
  sessionId: string;
  /** pending | processing | awaiting_result | completed | failed — and possibly others. */
  status: string;
  credential: PaymentCredential | null;
};

export type ReportOutcome = {
  confirmed: boolean;
  visaConfirmation: string;
};

export interface PravaPort {
  createSession(req: CreateSessionRequest): Promise<PravaSession>;
  getPaymentResult(sessionId: string): Promise<PaymentResult>;
  /** Takes the whole credential: the call needs both txn_ref_id and product_ref_id. */
  reportStatus(sessionId: string, credential: PaymentCredential, status: 'APPROVED' | 'DECLINED'): Promise<ReportOutcome>;
}

// ---------------------------------------------------------------------------
// Merchant redemption — the one disclosed simulation.
// ---------------------------------------------------------------------------

export type MandateExpectation = {
  amount: string;
  currency: string;
  merchantName: string;
};

export type RedemptionCheck = {
  check: 'amount_matches_mandate' | 'merchant_matches' | 'credential_not_replayed';
  passed: boolean;
  observed: string;
  expected: string;
};

export type RedemptionResult = {
  accepted: boolean;
  checks: RedemptionCheck[];
};

export interface MerchantPort {
  /** Enforces the mandate. Must reject wrong amount, wrong merchant, replayed credential. */
  redeem(credential: PaymentCredential, expected: MandateExpectation): RedemptionResult;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditEventType =
  | 'POLICY_APPROVED'
  | 'POLICY_BLOCKED'
  | 'HOLD_CREATED'
  | 'MANDATE_REQUESTED'
  | 'REDEMPTION_REJECTED'
  /** The refusal was made and recorded, but telling the network about it failed. */
  | 'REPORT_FAILED'
  | 'PAYMENT_APPROVED'
  | 'SETTLEMENT_FAILED'
  | 'TICKET_ISSUED';

export interface AuditPort {
  append(type: AuditEventType, payload: Record<string, unknown>): { seq: number; hash: string };
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
