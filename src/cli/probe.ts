/**
 * One-off probe: read a live credential from an already-authorised session and run the
 * mandate enforcement against it.
 *
 * Exists because the merchant and envelope parser were built entirely against captured
 * fixtures. This checks them against a credential Prava minted just now — the fixtures are
 * a redacted snapshot, and a snapshot can drift.
 *
 *   npx tsx src/cli/probe.ts <session_id>
 *
 * Does NOT call report-status, so the session stays at `awaiting_result` and no allowance
 * is consumed. Never prints the token or CVV.
 */

import { loadConfig } from '../config.js';
import { createPravaClient } from '../prava/client.js';
import { createSimulatedMerchant } from '../merchant/simulated-merchant.js';

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  if (!sessionId) throw new Error('usage: probe.ts <session_id>');

  const config = loadConfig();
  const prava = createPravaClient({
    baseUrl: config.pravaBaseUrl,
    secretKey: config.pravaSecretKey,
    merchantName: 'TravelGuard24',
    merchantUrl: 'https://travelguard24-demo.vercel.app',
    merchantCountry: 'AU',
  });

  const result = await prava.getPaymentResult(sessionId);
  console.log(`session status : ${result.status}`);

  const cred = result.credential;
  if (!cred) {
    console.log('no credential present — nothing to check');
    return;
  }

  console.log(`txn_ref_id     : ${cred.txnRefId}`);
  console.log(`product_ref_id : ${cred.productRefId || '(empty)'}`);
  console.log(`merchant_name  : ${cred.merchantName}`);
  console.log(`total_amount   : ${cred.totalAmount}`);
  console.log(`external_prod  : ${cred.externalProductId ?? '(null)'}`);
  console.log(`token          : ${cred.token.length} digits [redacted]`);
  console.log(`dynamic_cvv    : ${cred.dynamicCvv.length} digits [redacted]`);

  const show = (label: string, r: ReturnType<ReturnType<typeof createSimulatedMerchant>['redeem']>) => {
    console.log(`\n-- ${label} --`);
    for (const c of r.checks) {
      console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.check.padEnd(26)} ${c.observed}`);
    }
    console.log(`  accepted = ${r.accepted}`);
  };

  const merchant = createSimulatedMerchant({ merchantName: 'TravelGuard24' });
  const mandate = { amount: cred.totalAmount, currency: 'AUD', merchantName: 'TravelGuard24' };

  show('first presentation', merchant.redeem(cred, mandate));
  show('same credential again (replay)', merchant.redeem(cred, mandate));
  show('wrong amount', merchant.redeem(cred, { ...mandate, amount: '1500.00' }));
  show('wrong merchant', merchant.redeem(cred, { ...mandate, merchantName: 'Someone Else' }));
}

main().catch((err: unknown) => {
  console.error('PROBE FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
