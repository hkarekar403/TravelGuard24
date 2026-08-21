import { describe, expect, it } from 'vitest';
import { maskContact } from '../src/channel/types.js';

/**
 * A real mobile number was legible in a submission screenshot before this existed. The
 * browser now only ever receives the masked form, so it cannot reach a screen recording or
 * a shared debugging session at all — the full value stays server-side, where it is needed
 * to actually send the reply.
 */
describe('maskContact', () => {
  it('keeps only the last four digits of a phone number', () => {
    expect(maskContact('+61455501234')).toBe('••• 1234');
  });

  it('masks regardless of formatting', () => {
    expect(maskContact('+61 455 501 234')).toBe('••• 1234');
    expect(maskContact('(02) 9876 5432')).toBe('••• 5432');
  });

  it('keeps an email identifiable without disclosing it', () => {
    expect(maskContact('traveller@example.com')).toBe('t•••@example.com');
  });

  it('leaves a non-contact label alone — there is nothing to protect', () => {
    expect(maskContact('demo')).toBe('demo');
  });

  it('never returns the original for anything phone-shaped', () => {
    for (const n of ['+61455501234', '0455501234', '+1 415 555 0134']) {
      expect(maskContact(n)).not.toBe(n);
      expect(maskContact(n)).not.toContain(n.replace(/\D/g, '').slice(0, 6));
    }
  });
});

import { composeApproval, composeReply, groupMoney } from '../src/channel/outcome.js';
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
  // `detail` strings mirror src/policy/engine.ts exactly. An earlier fixture omitted the
  // cabin_class detail, which hid a real fault: with the engine's actual string the
  // message said "policy allows economy only" and never said business was asked for.
  rules: [
    {
      rule: 'cabin_class',
      passed: false,
      observed: 'business',
      expected: 'economy only',
      detail: 'policy allows economy only',
    },
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
    const text = composeReply({ status: 'BLOCKED_BY_POLICY', decision: blocked() }, { org: 'Acme Corp' });

    // What was asked for, then the rule it broke. The requirement alone doesn't tell the
    // traveller what they did.
    expect(text).toContain('cabin class — business, policy allows economy only');
    // ...but the fare total is on the line above, so the budget rule must not restate it.
    expect(text).toContain('budget cap — over by 5,804.08 AUD');
    expect(text).not.toContain('budget cap — 7,104.08 AUD');
    // Whose rules these are, not which revision of them.
    expect(text).toContain("Acme Corp's travel policy");
    expect(text).not.toContain('v1 travel policy');
    // A refusal without the number tells the traveller nothing actionable.
    expect(text).toContain('462');
  });

  it('formats every amount the same way within one message', () => {
    // "7104.08" beside "7,104.08" in one bubble reads as two different numbers.
    const text = composeReply({ status: 'BLOCKED_BY_POLICY', decision: blocked() });

    expect(text).toContain('7,104.08 AUD');
    expect(text).not.toMatch(/\b7104\.08\b/);
  });

  it('groups thousands without touching years, PNRs or small numbers', () => {
    expect(groupMoney('over by 5804.08 AUD')).toBe('over by 5,804.08 AUD');
    expect(groupMoney('45 days')).toBe('45 days');
    expect(groupMoney('departs 2026-09-15')).toBe('departs 2026-09-15');
    expect(groupMoney('reservation ABC123')).toBe('reservation ABC123');
    expect(groupMoney('123.45 AUD')).toBe('123.45 AUD');
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
      carrier: { iata: 'ZZ', name: 'Duffel Airways' },
      decision: { ...blocked(), outcome: 'APPROVED', selected, compliant: [selected] },
      redemption: { accepted: true, checks: [] },
    });

    expect(text).toContain('B6LDNQ');
    expect(text).toContain('1,202.75 AUD');
    expect(text).toContain('Duffel Airways');
    // Decision 1, stated to the person paying: locked to the price, not to the cap.
    expect(text).toContain('exact amount');
  });

  it('names the carrier BOOKED, not the one the gate picked', () => {
    // Seen live: the gate chose Iberia, Iberia refused the hold, American Airlines was
    // booked — and the confirmation said "Booked. Iberia." A traveller was told they were
    // flying an airline they were not.
    const selected = offer({ compliant: true, failedRules: [], carrier: { iata: 'IB', name: 'Iberia' } });
    const text = composeReply({
      status: 'CONFIRMED',
      pnr: 'A7AFCZ',
      sessionId: 's',
      eTicketNumber: '0123456789',
      amount: '1214.20',
      currency: 'AUD',
      carrier: { iata: 'AA', name: 'American Airlines' },
      decision: { ...blocked(), outcome: 'APPROVED', selected, compliant: [selected] },
      redemption: { accepted: true, checks: [] },
    });

    expect(text).toContain('American Airlines');
    expect(text).not.toContain('Iberia');
  });
});

describe('composeApproval', () => {
  const offer = { carrier: { name: 'British Airways' }, totalAmount: '1222.00', currency: 'AUD' };
  const url = 'https://sandbox.collect.prava.space?session=ses_01KYYGJN945R3TD1HD8AH5T083';

  it('ends with the link, so nothing is stranded below a wrapped URL', () => {
    // A session URL wraps to ~4 lines on a phone. Anything after it is buried, and what
    // would be buried is the terms of the mandate.
    const lines = composeApproval(offer, url).split('\n');

    expect(lines[lines.length - 1]).toBe(url);
    expect(composeApproval(offer, url).indexOf('Locked to this merchant')).toBeLessThan(
      composeApproval(offer, url).indexOf(url),
    );
  });

  it('states the amount and the lock before asking for a tap', () => {
    const text = composeApproval(offer, url);

    expect(text).toContain('1,222.00 AUD');
    expect(text).toContain('this exact amount');
    expect(text).toContain('British Airways');
  });

  it('sends the URL bare — never shortened or hidden behind a label', () => {
    // The traveller must be able to see where a payment link goes before tapping it.
    expect(composeApproval(offer, url)).toContain('sandbox.collect.prava.space');
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
