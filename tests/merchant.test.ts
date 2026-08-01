/**
 * The simulated merchant, tested against the real envelope shape.
 *
 * The fixture in `tests/fixtures/` is a redacted copy of an actual sandbox
 * `payment-result` — structure verbatim, credentials synthetic. The raw captures stay out
 * of the repo because they contain a live network token.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseCredential, parsePaymentResult } from '../src/prava/envelope.js';
import { createSimulatedMerchant, inMemorySeenStore } from '../src/merchant/simulated-merchant.js';
import { amountsEqual, formatMinorUnits, MalformedAmountError, toMinorUnits } from '../src/money.js';
import type { MandateExpectation, PaymentCredential } from '../src/orchestrator/ports.js';

const envelope = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/payment-result-awaiting-result.json', import.meta.url)), 'utf8'),
) as unknown;

const mandate: MandateExpectation = {
  amount: '1202.75',
  currency: 'AUD',
  merchantName: 'TravelGuard24',
};

function credentialFromFixture(): PaymentCredential {
  const c = parseCredential(envelope);
  if (!c) throw new Error('fixture should contain a credential');
  return c;
}

const merchant = () => createSimulatedMerchant({ merchantName: 'TravelGuard24', store: inMemorySeenStore() });

// ---------------------------------------------------------------------------

describe('money', () => {
  it('parses to minor units without touching a float', () => {
    expect(toMinorUnits('1202.75')).toBe(120275);
    expect(toMinorUnits('1203')).toBe(120300);
    expect(toMinorUnits('1203.5')).toBe(120350);
    expect(toMinorUnits('0.01')).toBe(1);
  });

  it('rejects anything ambiguous rather than guessing', () => {
    for (const bad of ['1,203.50', '1203.555', '-5.00', '', '1e3', 'abc', ' 12.00']) {
      expect(() => toMinorUnits(bad)).toThrow(MalformedAmountError);
    }
  });

  it('treats trailing zeros as equal, which string comparison would not', () => {
    const fromVendor: string = '1202.70';
    const reserialised: string = '1202.7';
    expect(amountsEqual(fromVendor, reserialised)).toBe(true);
    // The naive check the mandate comparison must not use.
    expect(fromVendor === reserialised).toBe(false);
  });

  it('round-trips through display formatting', () => {
    expect(formatMinorUnits(120275)).toBe('1202.75');
    expect(formatMinorUnits(1)).toBe('0.01');
  });
});

describe('payment-result envelope', () => {
  it('finds credentials nested under transactions[].line_items[], not top-level', () => {
    const c = credentialFromFixture();
    expect(c.txnRefId).toMatch(/^tli_/);
    expect(c.totalAmount).toBe('1202.75');
    expect(c.merchantName).toBe('TravelGuard24');
    expect(c.token).toHaveLength(16);
    expect(c.dynamicCvv).toHaveLength(3);
  });

  it('reports the SESSION status, which differs from the line item status', () => {
    const result = parsePaymentResult(envelope);
    // Session says awaiting_result; the line item says credentials_generated. Waiting for
    // a line item to say awaiting_result hangs forever.
    expect(result.status).toBe('awaiting_result');
    expect(result.credential).not.toBeNull();
  });

  it('carries the Duffel PNR back as the join key between both legs', () => {
    expect(credentialFromFixture().externalProductId).toBe('B6LDNQ');
  });

  it('returns null for a pending session rather than throwing', () => {
    // `transactions: []` is the normal state of a session nobody has opened yet.
    const pending = { session_id: 'ses_x', status: 'pending', transactions: [] };
    expect(parseCredential(pending)).toBeNull();
    expect(parsePaymentResult(pending).credential).toBeNull();
  });

  it('treats partial credentials as absent, never as usable', () => {
    const partial = {
      session_id: 'ses_x',
      status: 'awaiting_result',
      transactions: [{ line_items: [{ txn_ref_id: 'tli_x', total_amount: '1202.75' }] }],
    };
    expect(parseCredential(partial)).toBeNull();
  });
});

describe('mandate enforcement', () => {
  it('accepts a credential that matches the mandate', () => {
    const result = merchant().redeem(credentialFromFixture(), mandate);

    expect(result.accepted).toBe(true);
    expect(result.checks.map((c) => c.check)).toEqual([
      'amount_matches_mandate',
      'merchant_matches',
      'credential_not_replayed',
    ]);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('rejects a wrong amount, and stops before the later checks', () => {
    const result = merchant().redeem(credentialFromFixture(), { ...mandate, amount: '1500.00' });

    expect(result.accepted).toBe(false);
    // Decision 4: amount is the lead demo beat, so it is also the first check.
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.check).toBe('amount_matches_mandate');
    expect(result.checks[0]?.observed).toBe('1202.75 AUD');
    expect(result.checks[0]?.expected).toBe('1500.00 AUD');
  });

  it('rejects an amount that is over by a single cent', () => {
    const result = merchant().redeem(credentialFromFixture(), { ...mandate, amount: '1202.76' });
    expect(result.accepted).toBe(false);
  });

  it('accepts an equal amount written with a trailing zero', () => {
    const c = { ...credentialFromFixture(), totalAmount: '1202.750' as string };
    // Three decimal places is malformed and must fail closed, not be rounded.
    expect(merchant().redeem(c, mandate).accepted).toBe(false);

    const ok = { ...credentialFromFixture(), totalAmount: '1202.75' };
    expect(merchant().redeem(ok, mandate).accepted).toBe(true);
  });

  it('rejects a different merchant', () => {
    const c = { ...credentialFromFixture(), merchantName: 'Definitely Not TravelGuard24' };
    const result = merchant().redeem(c, mandate);

    expect(result.accepted).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks[1]?.check).toBe('merchant_matches');
  });
});

describe('replay protection — the gap Prava leaves open', () => {
  it('rejects the same credential presented twice', () => {
    const m = merchant();
    const c = credentialFromFixture();

    expect(m.redeem(c, mandate).accepted).toBe(true);
    const second = m.redeem(c, mandate);

    expect(second.accepted).toBe(false);
    expect(second.checks[2]?.check).toBe('credential_not_replayed');
    expect(second.checks[2]?.passed).toBe(false);
  });

  it('does NOT dedupe on the token, which is stable per card', () => {
    // Verified across four completed transactions: the token was identical every time
    // and only the dynamic CVV changed. Keying on the token would reject every
    // legitimate repeat purchase by the same traveller.
    const m = merchant();
    const first = credentialFromFixture();
    const laterPurchase: PaymentCredential = {
      ...first,
      txnRefId: 'tli_a_later_booking',
      token: first.token, // same card, same token
      dynamicCvv: '123', // different one-time value
    };

    expect(m.redeem(first, mandate).accepted).toBe(true);
    expect(m.redeem(laterPurchase, mandate).accepted).toBe(true);
  });

  it('catches a credential re-presented under a fabricated reference', () => {
    const m = merchant();
    const c = credentialFromFixture();
    expect(m.redeem(c, mandate).accepted).toBe(true);

    // Same token+CVV, new txn_ref_id — the txn key misses, the credential key catches it.
    const forged = { ...c, txnRefId: 'tli_made_up' };
    expect(m.redeem(forged, mandate).accepted).toBe(false);
  });

  it('does not consume the credential when it was rejected for another reason', () => {
    const m = merchant();
    const c = credentialFromFixture();

    // Rejected on amount — nothing was spent.
    expect(m.redeem(c, { ...mandate, amount: '9999.00' }).accepted).toBe(false);
    // So a corrected presentation must still succeed.
    expect(m.redeem(c, mandate).accepted).toBe(true);
  });

  it('shares state across merchant instances when the store is shared', () => {
    const store = inMemorySeenStore();
    const a = createSimulatedMerchant({ merchantName: 'TravelGuard24', store });
    const b = createSimulatedMerchant({ merchantName: 'TravelGuard24', store });
    const c = credentialFromFixture();

    expect(a.redeem(c, mandate).accepted).toBe(true);
    expect(b.redeem(c, mandate).accepted).toBe(false);
  });
});
