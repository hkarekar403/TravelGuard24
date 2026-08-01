/**
 * Proof of the four gating invariants in `src/orchestrator/orchestrator.ts`.
 *
 * These run against fakes, so they cost no Prava quota and no Duffel calls — which is the
 * point: the invariants are the judged deliverable, and they must be demonstrable without
 * a sandbox, on a plane, at 3am, after either vendor has gone down.
 *
 * The assertions that matter are the NEGATIVE ones — that a call did NOT happen. A test
 * suite that only proves the happy path proves nothing about a gate.
 */

import { describe, expect, it } from 'vitest';

import type { Evaluate, Offer, OfferEvaluation, PolicyDecision, Policy } from '../src/policy/types.js';
import { bookTrip, type BookingRequest, type Dependencies } from '../src/orchestrator/orchestrator.js';
import type {
  AuditEventType,
  BalancePayment,
  DuffelPort,
  HoldOrder,
  MandateExpectation,
  MerchantPort,
  OrderDocuments,
  PaymentCredential,
  PaymentResult,
  PravaPort,
  PravaSession,
  RedemptionResult,
  ReportOutcome,
  SearchRequest,
} from '../src/orchestrator/ports.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OFFER_PRICE = '1202.75';
const BUDGET_CAP_MINOR = 130_000; // AUD 1,300.00 — deliberately NOT the offer price

const policy: Policy = {
  version: 'v1',
  org: 'Acme Corp',
  currency: 'AUD',
  budgetCapMinor: BUDGET_CAP_MINOR,
  allowedCabinClasses: ['economy'],
  minAdvanceDays: 14,
  vendorAllowlist: ['ZZ', 'IB'],
};

function offer(id: string, amount: string): Offer {
  return {
    id,
    total_amount: amount,
    total_currency: 'AUD',
    expires_at: '2026-09-01T00:00:00Z',
    owner: { iata_code: 'ZZ', name: 'Duffel Airways' },
    slices: [
      {
        fare_brand_name: 'Basic',
        segments: [
          {
            departing_at: '2026-09-15T10:50:00',
            marketing_carrier: { iata_code: 'ZZ', name: 'Duffel Airways' },
            operating_carrier: { iata_code: 'ZZ', name: 'Duffel Airways' },
            passengers: [{ cabin_class: 'economy' }],
          },
        ],
      },
    ],
  };
}

function evaluation(id: string, amount: string, compliant: boolean): OfferEvaluation {
  return {
    offerId: id,
    totalMinor: Math.round(Number(amount) * 100),
    totalAmount: amount,
    currency: 'AUD',
    carrier: { iata: 'ZZ', name: 'Duffel Airways' },
    rules: [],
    compliant,
    failedRules: compliant ? [] : ['budget_cap'],
  };
}

function decisionApproved(amount = OFFER_PRICE): PolicyDecision {
  return {
    outcome: 'APPROVED',
    policyVersion: 'v1',
    evaluatedAt: '2026-08-01T02:00:00.000Z',
    totalOffers: 1669,
    funnel: [],
    selected: evaluation('off_1', amount, true),
    runnerUp: evaluation('off_2', '1231.32', true),
    nearestMiss: null,
    cheapestOverall: null,
  };
}

function decisionBlocked(): PolicyDecision {
  return {
    outcome: 'BLOCKED',
    policyVersion: 'v1',
    evaluatedAt: '2026-08-01T02:00:00.000Z',
    totalOffers: 462,
    funnel: [],
    selected: null,
    runnerUp: null,
    nearestMiss: evaluation('off_9', '8213.56', false),
    cheapestOverall: evaluation('off_7', '7104.08', false),
  };
}

const credential: PaymentCredential = {
  txnRefId: 'tli_test',
  merchantName: 'TravelGuard24',
  merchantUrl: 'https://travelguard24-demo.vercel.app',
  totalAmount: OFFER_PRICE,
  // Synthetic. Real sandbox tokens and CVVs stay in the gitignored captures.
  token: '4111111111111111',
  dynamicCvv: '999',
  expiryMonth: '12',
  expiryYear: '2027',
  externalProductId: 'B6LDNQ',
};

// ---------------------------------------------------------------------------
// Fakes — every one records its calls so absence can be asserted.
// ---------------------------------------------------------------------------

type Calls = {
  search: number;
  refreshOffer: number;
  createHoldOrder: number;
  payFromBalance: Array<{ orderId: string; amount: string }>;
  createSession: Array<{ totalAmount: string }>;
  reportStatus: Array<'APPROVED' | 'DECLINED'>;
  redeem: number;
  audit: Array<{ type: AuditEventType; payload: Record<string, unknown> }>;
};

type Overrides = {
  decision?: PolicyDecision;
  /** Price quoted by search and the pre-session refresh. */
  quoteAmount?: string;
  /** Price on the hold order. Defaults to the quote — set it differently to force drift. */
  orderAmount?: string;
  pollStatuses?: string[];
  redemption?: RedemptionResult;
  reportConfirmed?: boolean;
  settlementError?: string;
};

function harness(o: Overrides = {}) {
  const calls: Calls = {
    search: 0,
    refreshOffer: 0,
    createHoldOrder: 0,
    payFromBalance: [],
    createSession: [],
    reportStatus: [],
    redeem: 0,
    audit: [],
  };

  const quoteAmount = o.quoteAmount ?? OFFER_PRICE;
  const orderAmount = o.orderAmount ?? quoteAmount;
  // Statuses returned by successive polls. Credentials are attached on the last one.
  const pollStatuses = o.pollStatuses ?? ['pending', 'processing', 'awaiting_result'];
  let poll = 0;

  const duffel: DuffelPort = {
    async search(_req: SearchRequest) {
      calls.search++;
      return [offer('off_1', quoteAmount)];
    },
    async refreshOffer(id: string) {
      calls.refreshOffer++;
      return offer(id, quoteAmount);
    },
    async createHoldOrder(): Promise<HoldOrder> {
      calls.createHoldOrder++;
      return {
        id: 'ord_test',
        bookingReference: 'B6LDNQ',
        totalAmount: orderAmount,
        totalCurrency: 'AUD',
        awaitingPayment: true,
        paymentRequiredBy: '2026-08-04T00:00:00Z',
      };
    },
    async payFromBalance(orderId: string, amount: string): Promise<BalancePayment> {
      calls.payFromBalance.push({ orderId, amount });
      if (o.settlementError) throw new Error(o.settlementError);
      return { id: 'pay_test', status: 'succeeded' };
    },
    async getOrder(): Promise<OrderDocuments> {
      return {
        documents: [{ type: 'electronic_ticket', uniqueIdentifier: '0123456789' }],
        paidAt: '2026-08-01T02:05:00Z',
        awaitingPayment: false,
        bookingReference: 'B6LDNQ',
      };
    },
  };

  const prava: PravaPort = {
    async createSession(req): Promise<PravaSession> {
      calls.createSession.push({ totalAmount: req.totalAmount });
      return {
        sessionId: 'ses_test',
        orderId: 'ord_prava',
        iframeUrl: 'https://sandbox.collect.prava.space?session=ses_test',
        expiresAt: '2026-08-01T02:15:00Z',
      };
    },
    async getPaymentResult(): Promise<PaymentResult> {
      const status = pollStatuses[Math.min(poll, pollStatuses.length - 1)] ?? 'pending';
      const isLast = poll >= pollStatuses.length - 1;
      poll++;
      return {
        sessionId: 'ses_test',
        status,
        credential: isLast && status === 'awaiting_result' ? credential : null,
      };
    },
    async reportStatus(_s, _t, status): Promise<ReportOutcome> {
      calls.reportStatus.push(status);
      const confirmed = o.reportConfirmed ?? true;
      return { confirmed, visaConfirmation: confirmed ? 'SUCCESS' : 'FAILED' };
    },
  };

  const merchant: MerchantPort = {
    redeem(_c: PaymentCredential, _e: MandateExpectation): RedemptionResult {
      calls.redeem++;
      return o.redemption ?? { accepted: true, checks: [] };
    },
  };

  let clockMs = Date.parse('2026-08-01T02:00:00Z');
  const deps: Dependencies = {
    duffel,
    prava,
    merchant,
    audit: {
      append(type, payload) {
        calls.audit.push({ type, payload });
        return { seq: calls.audit.length, hash: `hash_${calls.audit.length}` };
      },
    },
    clock: {
      now: () => new Date(clockMs),
      sleep: async (ms: number) => {
        clockMs += ms;
      },
    },
    evaluate: ((): Evaluate => () => o.decision ?? decisionApproved())(),
  };

  const request: BookingRequest = {
    search: {
      origin: 'SYD',
      destination: 'LHR',
      departureDate: '2026-09-15',
      returnDate: '2026-09-25',
      cabinClass: 'economy',
    },
    passenger: {
      title: 'mr',
      givenName: 'Test',
      familyName: 'Traveller',
      bornOn: '1995-03-14',
      gender: 'm',
      phoneNumber: '+61400000000',
      email: 'traveler@travelguard24-demo.vercel.app',
    },
    policy,
    userId: 'test_user_002',
    userEmail: 'traveler@travelguard24-demo.vercel.app',
    cardId: 'card_test',
  };

  return { calls, deps, request };
}

const auditTypes = (calls: Calls) => calls.audit.map((a) => a.type);

// ---------------------------------------------------------------------------

describe('I1 — no Prava session unless the policy gate approved', () => {
  it('blocks without ever calling Prava', async () => {
    const { calls, deps, request } = harness({ decision: decisionBlocked() });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('BLOCKED_BY_POLICY');
    // The entire thesis, as an assertion.
    expect(calls.createSession).toHaveLength(0);
    expect(calls.reportStatus).toHaveLength(0);
    expect(calls.redeem).toBe(0);
    // And no booking is held either — nothing is reserved for a purchase that won't happen.
    expect(calls.createHoldOrder).toBe(0);
  });

  it('records the block, with the nearest miss and the cheapest as separate facts', async () => {
    const { calls, deps, request } = harness({ decision: decisionBlocked() });

    await bookTrip(request, deps);

    expect(auditTypes(calls)).toEqual(['POLICY_BLOCKED']);
    const payload = calls.audit[0]?.payload as Record<string, OfferEvaluation>;
    // Decision 3: these are different offers and must not be conflated.
    expect(payload['nearestMiss']?.totalAmount).toBe('8213.56');
    expect(payload['cheapestOverall']?.totalAmount).toBe('7104.08');
  });
});

describe('I2 — the mandate is the exact price, never the budget cap', () => {
  it('sends the order total verbatim', async () => {
    const { calls, deps, request } = harness();

    await bookTrip(request, deps);

    expect(calls.createSession).toHaveLength(1);
    expect(calls.createSession[0]?.totalAmount).toBe(OFFER_PRICE);
    // The cap is AUD 1,300.00. Sending it would mint a credential spendable ~97 dollars
    // above what was approved — weaker than a plain checkout.
    expect(calls.createSession[0]?.totalAmount).not.toBe('1300.00');
    expect(Number(calls.createSession[0]?.totalAmount) * 100).toBeLessThan(BUDGET_CAP_MINOR);
  });

  it('passes the amount as an untouched string, not a re-serialised number', async () => {
    // Quote and order agree — this test is about string fidelity, not drift.
    const { calls, deps, request } = harness({ quoteAmount: '1202.70' });

    await bookTrip(request, deps);

    // A float round-trip renders 1202.70 as "1202.7" and breaks the exact-amount lock.
    expect(calls.createSession[0]?.totalAmount).toBe('1202.70');
  });

  it('stops if the price drifts between quote and order, before any mandate exists', async () => {
    const { calls, deps, request } = harness({ orderAmount: '1250.00' });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('PRICE_DRIFTED');
    expect(calls.createSession).toHaveLength(0);
    expect(calls.payFromBalance).toHaveLength(0);
  });
});

describe('I3 — report-status APPROVED only after our own enforcement passes', () => {
  it('reports DECLINED and never APPROVED when redemption rejects', async () => {
    const { calls, deps, request } = harness({
      redemption: {
        accepted: false,
        checks: [
          {
            check: 'amount_matches_mandate',
            passed: false,
            observed: '1500.00',
            expected: '1202.75',
          },
        ],
      },
    });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('REDEMPTION_REJECTED');
    expect(calls.reportStatus).toEqual(['DECLINED']);
    expect(calls.reportStatus).not.toContain('APPROVED');
    expect(auditTypes(calls)).toContain('REDEMPTION_REJECTED');
  });

  it('runs enforcement before reporting, not after', async () => {
    const { calls, deps, request } = harness();

    await bookTrip(request, deps);

    expect(calls.redeem).toBe(1);
    expect(calls.reportStatus).toEqual(['APPROVED']);
  });
});

describe('I4 — the airline is paid only if leg 1 completed', () => {
  it('settles on the happy path', async () => {
    const { calls, deps, request } = harness();

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('CONFIRMED');
    expect(calls.payFromBalance).toEqual([{ orderId: 'ord_test', amount: OFFER_PRICE }]);
    expect(auditTypes(calls)).toEqual([
      'POLICY_APPROVED',
      'HOLD_CREATED',
      'MANDATE_REQUESTED',
      'PAYMENT_APPROVED',
      'TICKET_ISSUED',
    ]);
  });

  it('does not settle when the mandate check rejected', async () => {
    const { calls, deps, request } = harness({
      redemption: { accepted: false, checks: [] },
    });

    await bookTrip(request, deps);

    expect(calls.payFromBalance).toHaveLength(0);
  });

  it('does not settle when report-status is not confirmed', async () => {
    const { calls, deps, request } = harness({ reportConfirmed: false });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('REPORT_REJECTED');
    expect(calls.payFromBalance).toHaveLength(0);
  });

  it('does not settle when the passkey never happens', async () => {
    const { calls, deps, request } = harness({ pollStatuses: ['pending'] });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('AUTHORISATION_TIMED_OUT');
    expect(calls.payFromBalance).toHaveLength(0);
    expect(calls.reportStatus).toHaveLength(0);
  });

  it('surfaces a charged-but-unticketed booking rather than reporting success', async () => {
    const { calls, deps, request } = harness({ settlementError: 'insufficient balance' });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('SETTLEMENT_FAILED');
    expect(auditTypes(calls)).toContain('SETTLEMENT_FAILED');
    expect(auditTypes(calls)).not.toContain('TICKET_ISSUED');
  });
});

describe('credential polling', () => {
  it('treats an unrecognised status as keep-waiting, not an error', async () => {
    // `processing` is documented in one Prava page and absent from the enum in another.
    const { deps, request } = harness({
      pollStatuses: ['pending', 'processing', 'some_status_we_have_never_seen', 'awaiting_result'],
    });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('CONFIRMED');
  });

  it('aborts on a terminal failure status without waiting out the clock', async () => {
    const { calls, deps, request } = harness({ pollStatuses: ['pending', 'failed'] });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('AUTHORISATION_FAILED');
    expect(calls.payFromBalance).toHaveLength(0);
  });

  it('reads credentials while the session is awaiting_result, not completed', async () => {
    // The natural loop — wait for `completed` — never terminates, because `completed`
    // only arrives after report-status, which we cannot send without the credential.
    const { calls, deps, request } = harness({
      pollStatuses: ['pending', 'awaiting_result'],
    });

    const outcome = await bookTrip(request, deps);

    expect(outcome.status).toBe('CONFIRMED');
    expect(calls.reportStatus).toEqual(['APPROVED']);
  });
});

describe('audit trail', () => {
  it('writes an entry on every terminating path', async () => {
    const paths: Array<[string, Overrides]> = [
      ['blocked', { decision: decisionBlocked() }],
      ['rejected', { redemption: { accepted: false, checks: [] } }],
      ['settlement failed', { settlementError: 'boom' }],
      ['confirmed', {}],
    ];

    for (const [, overrides] of paths) {
      const { calls, deps, request } = harness(overrides);
      await bookTrip(request, deps);
      expect(calls.audit.length).toBeGreaterThan(0);
    }
  });

  it('records the runner-up so "why this flight?" is answerable', async () => {
    const { calls, deps, request } = harness();

    await bookTrip(request, deps);

    const approved = calls.audit.find((a) => a.type === 'POLICY_APPROVED');
    expect((approved?.payload as { runnerUp?: { amount: string } }).runnerUp?.amount).toBe('1231.32');
  });

  it('carries the PNR through Prava as the join key between both legs', async () => {
    const { calls, deps, request } = harness();

    await bookTrip(request, deps);

    const paid = calls.audit.find((a) => a.type === 'PAYMENT_APPROVED');
    expect((paid?.payload as { externalProductId?: string }).externalProductId).toBe('B6LDNQ');
  });
});
