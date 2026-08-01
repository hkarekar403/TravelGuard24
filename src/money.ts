/**
 * Money handling.
 *
 * Both vendors express amounts as decimal STRINGS ("1202.75"). Every comparison in this
 * codebase happens in integer minor units, and the original string is what travels to
 * Prava — decision 1 requires the mandate amount to equal the quoted price exactly, and a
 * float round-trip silently rewrites "1202.70" as "1202.7".
 *
 * Shared by the policy engine and the merchant redemption so the two can never disagree
 * about whether two amounts are equal.
 */

/** Amounts with at most two decimal places. No thousands separators, no sign, no exponent. */
const AMOUNT = /^\d+(\.\d{1,2})?$/;

export class MalformedAmountError extends Error {
  constructor(readonly amount: string) {
    super(`Malformed amount: ${JSON.stringify(amount)}`);
    this.name = 'MalformedAmountError';
  }
}

/**
 * "1202.75" -> 120275, "1203" -> 120300, "1203.5" -> 120350.
 *
 * Throws on anything else. Failing closed matters: an unparseable amount must never be
 * treated as zero, or as passing a budget check.
 */
export function toMinorUnits(amount: string): number {
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) {
    throw new MalformedAmountError(String(amount));
  }
  const [whole = '0', frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** 120275 -> "1202.75". For display only — never send this back to a vendor. */
export function formatMinorUnits(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** True when two decimal strings denote the same amount, regardless of trailing zeros. */
export function amountsEqual(a: string, b: string): boolean {
  return toMinorUnits(a) === toMinorUnits(b);
}
