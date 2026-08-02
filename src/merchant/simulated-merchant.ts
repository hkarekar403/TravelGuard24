/**
 * The simulated merchant — the one disclosed simulation in this system, and the only
 * component that is not talking to a real vendor.
 *
 * WHY IT IS SIMULATED. In sandbox, no merchant anywhere accepts a Prava credential. Prava
 * engineering put this in writing: a sandbox token "cannot be used to complete a live
 * transaction… the transaction will fail at the final checkout stage on the merchant's
 * side", and submitting it to a merchant and letting it be declined is "completely
 * acceptable for the hackathon". Sandboxes only recognise their own test data; none of
 * them reach Visa's network. So this step is modelled rather than performed.
 *
 * WHY IT IS NOT A STUB. Prava's suggested baseline is a "dummy store". This does more: it
 * ENFORCES the mandate the credential was issued under. That converts the simulated
 * component from a placeholder into a live demonstration of VIC pillars 1 and 3 — the
 * payment-layer equivalent of the blocked-booking branch.
 *
 * Replay protection genuinely has to live here: Prava accepts a duplicate `report-status`
 * for the same `txn_ref_id` and returns APPROVED / SUCCESS a second time. We verified that
 * against their sandbox. Their own guardrails page claims duplicate transactions within a
 * session are detected and rejected; in our capture that did not fire.
 */

import { createHash } from 'node:crypto';

import { amountsEqual, MalformedAmountError } from '../money.js';
import type {
  MandateExpectation,
  MerchantPort,
  PaymentCredential,
  RedemptionCheck,
  RedemptionResult,
} from '../orchestrator/ports.js';

/** Records credentials that have already been redeemed. Injected so it can be persisted. */
export interface SeenCredentialStore {
  has(key: string): boolean;
  add(key: string): void;
}

export function inMemorySeenStore(): SeenCredentialStore {
  const seen = new Set<string>();
  return {
    has: (k) => seen.has(k),
    add: (k) => void seen.add(k),
  };
}

/**
 * Keys a credential for replay detection.
 *
 * NEVER the token alone. The network token is stable per enrolled card — identical across
 * all four of our completed transactions (only the dynamic CVV changed: 494, 260, 217,
 * 685). Deduplicating on the token would reject every legitimate repeat purchase by the
 * same traveller, which is the normal case, not the attack.
 *
 * Two independent keys, because each catches something the other misses:
 *  - `txn_ref_id` is the transaction identity, and precisely the value Prava failed to
 *    deduplicate on. This is the hole we are filling.
 *  - token+CVV catches the same credential re-presented under a fabricated reference. The
 *    CVV is one-time per transaction, but it is only three digits, so it is a poor key on
 *    its own — pairing it with the token is what makes it discriminating.
 */
function replayKeys(c: PaymentCredential): string[] {
  // The credential key is HASHED, not stored raw.
  //
  // A dynamic CVV is a one-time cryptogram, but it is still an authentication value, and
  // PCI DSS is unambiguous that authentication data must not be retained after
  // authorisation. Keeping `token:cvv` in a Set for the life of the process is retention,
  // even though it never reaches disk or a log. SHA-256 dedupes exactly as well — the input
  // is what must be unique, not the stored form — while leaving nothing replayable behind.
  return [`txn:${c.txnRefId}`, `cred:${createHash('sha256').update(`${c.token}:${c.dynamicCvv}`).digest('hex')}`];
}

/**
 * Short, non-reversible label for a credential presentation.
 *
 * Used instead of printing the dynamic CVV. The check result is written to the audit log,
 * which is the artifact most likely to end up in a screenshot or a submission — so it must
 * not carry a live credential value, one-time or not. A fingerprint reads better on screen
 * anyway, and it still changes visibly between presentations, which is the point being
 * demonstrated.
 */
export function credentialFingerprint(c: PaymentCredential): string {
  return createHash('sha256').update(`${c.token}:${c.dynamicCvv}`).digest('hex').slice(0, 8);
}

export type SimulatedMerchantOptions = {
  /** The merchant this store believes itself to be. Compared against the mandate. */
  merchantName: string;
  store?: SeenCredentialStore;
};

export function createSimulatedMerchant(opts: SimulatedMerchantOptions): MerchantPort {
  const store = opts.store ?? inMemorySeenStore();

  return {
    redeem(credential: PaymentCredential, expected: MandateExpectation): RedemptionResult {
      const checks: RedemptionCheck[] = [];

      const reject = (): RedemptionResult => ({ accepted: false, checks });

      // -- 1. Amount --------------------------------------------------------
      // Led with deliberately. This is the check the card network genuinely enforces
      // at VisaNet, so it maps cleanly onto pillar 1 and is the least theatrical of
      // the three to demonstrate.
      let amountOk: boolean;
      try {
        amountOk = amountsEqual(credential.totalAmount, expected.amount);
      } catch (err) {
        // A malformed amount fails closed. It is never "close enough".
        if (!(err instanceof MalformedAmountError)) throw err;
        amountOk = false;
      }
      checks.push({
        check: 'amount_matches_mandate',
        passed: amountOk,
        observed: `${credential.totalAmount} ${expected.currency}`,
        expected: `${expected.amount} ${expected.currency}`,
      });
      // Stop at the first violated constraint, the way an acquirer would — and the way
      // the UI renders it, with later rows never appearing.
      if (!amountOk) return reject();

      // -- 2. Merchant ------------------------------------------------------
      const merchantOk = credential.merchantName === expected.merchantName;
      checks.push({
        check: 'merchant_matches',
        passed: merchantOk,
        observed: credential.merchantName || '(none)',
        expected: expected.merchantName,
      });
      if (!merchantOk) return reject();

      // -- 3. Replay --------------------------------------------------------
      const keys = replayKeys(credential);
      const replayed = keys.some((k) => store.has(k));
      const fingerprint = credentialFingerprint(credential);
      checks.push({
        check: 'credential_not_replayed',
        passed: !replayed,
        observed: replayed ? `credential ${fingerprint} already redeemed` : `credential ${fingerprint} unseen`,
        expected: 'first presentation',
      });
      if (replayed) return reject();

      // Consume the credential only on acceptance. A presentation rejected for a wrong
      // amount did not spend it, so a corrected retry must still be able to succeed.
      for (const k of keys) store.add(k);

      return { accepted: true, checks };
    },
  };
}
