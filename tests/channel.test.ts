import { describe, expect, it } from 'vitest';

import { composeReply } from '../src/channel/outcome.js';
import { createDemoChannel } from '../src/channel/demo.js';
import { createSeenSet } from '../src/channel/types.js';
import type { BookingOutcome } from '../src/orchestrator/orchestrator.js';
import type { OfferEvaluation, PolicyDecision } from '../src/policy/types.js';

const offer = (over: Partial<OfferEvaluation> = {}): OfferEvaluation => ({
  offerId: 'off_1',
  totalMinor: 710408,
  totalAmount: '7104.08',
  currency: 'AUD',
  carrier: { iata: 'BA', name: 'British Airways' },
  compliant: false,
  failedRules: ['cabin_class', 'budget_cap'],
  rules: [
    { rule: 'cabin_class', passed: false, observed: 'business', expected: 'economy only' },
    { rule: 'vendor_allowlist', passed: true, observed: 'BA', expected: 'on list' },
    { rule: 'advance_purchase', passed: true, observed: '45 days', expected: '>= 14 days' },
    {
      rule: 'budget_cap',
      passed: false,
      observed: '7104.08 AUD',
      expected: '<= 1300.00 AUD',
      detail: 'over by 5804.08 AUD',
    },
  ],
  ...over,
});

const blocked = (): PolicyDecision => ({
  outcome: 'BLOCKED',
  policyVersion: 'v1',
  evaluatedAt: '2026-08-01T09:00:00.000Z',
  totalOffers: 462,
  funnel: [{ rule: 'cabin_class', remaining: 0 }],
  compliant: [],
  selected: null,
  runnerUp: null,
  nearestMiss: offer(),
  cheapestOverall: offer({ offerId: 'off_2', totalAmount: '7096.97' }),
});

describe('composeReply', () => {
  it('names every failed rule and the overage when blocked', () => {
    const text = composeReply({ status: 'BLOCKED_BY_POLICY', decision: blocked() });

    expect(text).toContain('cabin class: business');
    expect(text).toContain('budget cap: 7104.08 AUD — over by 5804.08 AUD');
    // A refusal without the number tells the traveller nothing actionable.
    expect(text).toContain('462');
  });

  it('says "Nothing was charged" verbatim on every outcome where no money moved', () => {
    // The traveller's first question on being declined is whether they paid anyway, and
    // the answer must not be phrased differently each time — one phrase, always findable.
    const outcomes: BookingOutcome[] = [
      { status: 'BLOCKED_BY_POLICY', decision: blocked() },
      { status: 'NO_BOOKABLE_OFFER', attempts: [{ offerId: 'o', carrier: 'Iberia', error: '422' }] },
      { status: 'PRICE_DRIFTED', quoted: '1202.75', ordered: '1310.00', pnr: 'ABC123' },
      { status: 'AUTHORISATION_TIMED_OUT', pnr: 'ABC123', sessionId: 's' },
      { status: 'AUTHORISATION_FAILED', pnr: 'ABC123', sessionId: 's', pravaStatus: 'failed' },
      { status: 'REPORT_REJECTED', pnr: 'ABC123', sessionId: 's', visaConfirmation: 'FAIL' },
    ];

    for (const outcome of outcomes) {
      expect(composeReply(outcome), outcome.status).toContain('Nothing was charged');
    }
  });

  it('never leaks a credential, a session id or a token', () => {
    const outcome: BookingOutcome = {
      status: 'REDEMPTION_REJECTED',
      pnr: 'ABC123',
      sessionId: 'ses_01KYCD6X75YV2V3DY2N2HK83SM',
      redemption: { accepted: false, checks: [] },
    };
    const text = composeReply(outcome);

    // These go to a handset over a channel we do not control, and get screenshotted.
    expect(text).not.toContain('ses_');
    expect(text).toContain('ABC123');
  });

  it('does not soften the one outcome where money actually moved', () => {
    const text = composeReply({
      status: 'SETTLEMENT_FAILED',
      pnr: 'ABC123',
      sessionId: 's',
      error: 'balance too low',
    });

    expect(text).toContain('went through');
    expect(text).toContain('has not been issued');
  });

  it('reports the amount and the mandate lock when confirmed', () => {
    const selected = offer({ compliant: true, failedRules: [], totalAmount: '1202.75', carrier: { iata: 'ZZ', name: 'Duffel Airways' } });
    const text = composeReply({
      status: 'CONFIRMED',
      pnr: 'B6LDNQ',
      sessionId: 's',
      eTicketNumber: '0123456789',
      amount: '1202.75',
      currency: 'AUD',
      decision: { ...blocked(), outcome: 'APPROVED', selected, compliant: [selected] },
      redemption: { accepted: true, checks: [] },
    });

    expect(text).toContain('B6LDNQ');
    expect(text).toContain('1,202.75 AUD');
    expect(text).toContain('Duffel Airways');
    // Decision 1, stated to the person paying: locked to the price, not to the cap.
    expect(text).toContain('exact amount');
  });
});

describe('seen set', () => {
  it('reports an id only once as unseen', () => {
    const seen = createSeenSet();
    expect(seen.seen('m1')).toBe(false);
    seen.mark('m1');
    expect(seen.seen('m1')).toBe(true);
  });
});

describe('demo channel', () => {
  it('hands each injected message out exactly once', async () => {
    // A channel that redelivers is a channel that double-books.
    const channel = createDemoChannel();
    channel.inject('Book me SYD to LHR');

    expect(await channel.poll()).toHaveLength(1);
    expect(await channel.poll()).toHaveLength(0);
  });

  it('keeps replies instead of sending them', async () => {
    const channel = createDemoChannel();
    await channel.reply('demo-thread', 'Booked. ABC123.');

    expect(channel.sent()).toEqual([{ threadId: 'demo-thread', text: 'Booked. ABC123.' }]);
  });
});
