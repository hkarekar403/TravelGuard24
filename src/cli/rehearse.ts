/**
 * CHAINED REHEARSAL — the full flow, end to end, for real.
 *
 * This drives the ACTUAL orchestrator, not a parallel copy, so what it proves is the thing
 * that gets judged: that leg 2 fires only because leg 1 completed. Both legs have been
 * verified independently before; the ordering between them never has been outside of fakes.
 *
 * COSTS ONE PRAVA COMPLETION and needs one human passkey tap, in Chrome, Default profile.
 *
 *   npx tsx src/cli/rehearse.ts
 *
 * The policy evaluator here is a deliberately minimal stand-in — enough to produce a real
 * PolicyDecision from live offers so the orchestrator has something to gate on. The full
 * engine is specified in docs/policy-engine.md and is built separately; this file must not
 * become its second implementation.
 */

import { spawn } from 'node:child_process';

import { loadConfig } from '../config.js';
import { createDuffelClient } from '../duffel/client.js';
import { createPravaClient } from '../prava/client.js';
import { createSimulatedMerchant } from '../merchant/simulated-merchant.js';
import { createHashChainAudit } from '../audit/hash-chain.js';
import { bookTrip } from '../orchestrator/orchestrator.js';
import { toMinorUnits } from '../money.js';
import type { Evaluate, OfferEvaluation, Policy } from '../policy/types.js';
import type { Clock, PravaPort } from '../orchestrator/ports.js';

const policy: Policy = {
  version: 'v1',
  org: 'Acme Corp',
  currency: 'AUD',
  budgetCapMinor: 130_000, // AUD 1,300.00
  allowedCabinClasses: ['economy'],
  minAdvanceDays: 14,
  vendorAllowlist: ['ZZ', 'IB', 'BA', 'AA', 'SQ', 'LH', 'QR', 'EY', 'NH', 'JL', 'TG', 'AI'],
};

/** Minimal stand-in for the real engine. See the file header. */
const evaluate: Evaluate = (offers, p, now) => {
  const evaluated: OfferEvaluation[] = offers.map((o) => {
    const cabins = o.slices.flatMap((s) => s.segments.flatMap((g) => g.passengers.map((x) => x.cabin_class)));
    const departure = o.slices[0]?.segments[0]?.departing_at?.slice(0, 10) ?? '';
    const days = Math.floor((Date.parse(`${departure}T00:00:00Z`) - Date.parse(now.toISOString().slice(0, 10) + 'T00:00:00Z')) / 86_400_000);
    const minor = toMinorUnits(o.total_amount);

    const failed: OfferEvaluation['failedRules'] = [];
    if (!cabins.every((c) => p.allowedCabinClasses.includes(c))) failed.push('cabin_class');
    if (!p.vendorAllowlist.includes(o.owner.iata_code)) failed.push('vendor_allowlist');
    if (days < p.minAdvanceDays) failed.push('advance_purchase');
    if (minor > p.budgetCapMinor) failed.push('budget_cap');

    return {
      offerId: o.id,
      totalMinor: minor,
      totalAmount: o.total_amount,
      currency: o.total_currency,
      carrier: { iata: o.owner.iata_code, name: o.owner.name },
      rules: [],
      compliant: failed.length === 0,
      failedRules: failed,
    };
  });

  const compliant = evaluated
    .filter((e) => e.compliant)
    .sort((a, b) => a.totalMinor - b.totalMinor || (a.offerId < b.offerId ? -1 : 1));

  return {
    outcome: compliant.length > 0 ? 'APPROVED' : 'BLOCKED',
    policyVersion: p.version,
    evaluatedAt: now.toISOString(),
    totalOffers: offers.length,
    funnel: [],
    compliant,
    selected: compliant[0] ?? null,
    runnerUp: compliant[1] ?? null,
    nearestMiss: null,
    cheapestOverall: null,
  };
};

const clock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

async function main(): Promise<void> {
  const config = loadConfig();
  const audit = createHashChainAudit(clock);

  const duffel = createDuffelClient({ baseUrl: config.duffelBaseUrl, apiKey: config.duffelApiKey });

  const realPrava = createPravaClient({
    baseUrl: config.pravaBaseUrl,
    secretKey: config.pravaSecretKey,
    merchantName: 'TravelGuard24',
    merchantUrl: 'https://travelguard24-demo.vercel.app',
    merchantCountry: 'AU',
  });

  // Opens the checkout as a side effect of session creation, so the orchestrator stays
  // unaware of anything browser-shaped. In the real UI this is the passkey step.
  const prava: PravaPort = {
    ...realPrava,
    async createSession(req) {
      const session = await realPrava.createSession(req);
      console.log(`\n   session ${session.sessionId} · expires ${session.expiresAt}`);
      console.log(`   mandate amount ${req.totalAmount} ${req.currency} — the exact order total`);
      console.log('\n   >>> OPENING CHROME. Tap the passkey. <<<');
      console.log('   If it shows a card form instead of your saved card, STOP — wrong browser profile.\n');
      spawn('cmd', ['/c', 'start', 'chrome', session.iframeUrl], { stdio: 'ignore', detached: true }).unref();
      return session;
    },
  };

  const merchant = createSimulatedMerchant({ merchantName: 'TravelGuard24' });

  const started = Date.now();
  const outcome = await bookTrip(
    {
      search: {
        origin: 'SYD',
        destination: 'LHR',
        departureDate: '2026-09-15',
        returnDate: '2026-09-25',
        cabinClass: 'economy',
      },
      passenger: {
        title: 'mr',
        givenName: 'Harshad',
        familyName: 'Karekar',
        bornOn: '1995-03-14',
        gender: 'm',
        phoneNumber: '+61400000000',
        email: 'traveler@travelguard24-demo.vercel.app',
      },
      policy,
      userId: 'test_user_002',
      userEmail: 'traveler@travelguard24-demo.vercel.app',
      // Deliberately empty — see the note in prava/client.ts. Pre-selection stalls
      // the hosted checkout at the order summary with no way to proceed.
      cardId: '',
    },
    { duffel, prava, merchant, audit, clock, evaluate },
  );

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`OUTCOME: ${outcome.status}   (${Math.round((Date.now() - started) / 1000)}s)`);
  console.log(`${'─'.repeat(72)}`);

  if (outcome.status === 'CONFIRMED') {
    console.log(`  PNR         ${outcome.pnr}`);
    console.log(`  E-ticket    ${outcome.eTicketNumber ?? '(none returned)'}`);
    console.log(`  Amount      ${outcome.amount} ${outcome.currency}`);
    console.log(`  Session     ${outcome.sessionId}`);
    console.log('\n  Mandate enforcement:');
    for (const c of outcome.redemption.checks) {
      console.log(`    ${c.passed ? 'PASS' : 'FAIL'}  ${c.check.padEnd(26)} ${c.observed}`);
    }
  } else {
    console.log(JSON.stringify(outcome, null, 2).slice(0, 1200));
  }

  console.log('\n  Audit chain:');
  for (const e of audit.entries()) {
    console.log(`    #${e.seq}  ${e.type.padEnd(20)} ${e.hash.slice(0, 12)}…  ← prev ${e.prevHash.slice(0, 8)}…`);
  }
  const verified = audit.verify();
  console.log(`  chain ${verified.ok ? 'VERIFIED' : `BROKEN at #${verified.brokenAt}`}`);
}

main().catch((err: unknown) => {
  console.error('\nREHEARSAL FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
