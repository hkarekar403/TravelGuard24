/**
 * Client smoke test — exercises every vendor call the booking flow makes, except the two
 * that cost something.
 *
 * FREE BY CONSTRUCTION:
 *  - Duffel search, offer refresh and hold orders cost nothing (a hold reserves seats at
 *    zero payment and expires on its own).
 *  - Prava session creation costs no quota. Only a COMPLETED transaction decrements the
 *    sandbox allowance, and completing one requires a human passkey tap that this script
 *    never triggers.
 *
 * It deliberately stops before `report-status` and before the balance settlement. Run it
 * to check the wiring, not to book anything.
 *
 *   npx tsx src/cli/smoke.ts
 */

import { loadConfig } from '../config.js';
import { createDuffelClient } from '../duffel/client.js';
import { createPravaClient } from '../prava/client.js';
import { toMinorUnits } from '../money.js';

const CAP_MINOR = 130_000; // AUD 1,300.00

async function main(): Promise<void> {
  const config = loadConfig();

  const duffel = createDuffelClient({ baseUrl: config.duffelBaseUrl, apiKey: config.duffelApiKey });
  const prava = createPravaClient({
    baseUrl: config.pravaBaseUrl,
    secretKey: config.pravaSecretKey,
    merchantName: 'TravelGuard24',
    merchantUrl: 'https://travelguard24.vercel.app',
    merchantCountry: 'AU',
  });

  const step = (n: string) => process.stdout.write(`\n── ${n}\n`);
  const started = Date.now();
  const ms = (from: number) => `${Date.now() - from}ms`;

  // -- Duffel search ---------------------------------------------------------
  step('Duffel search');
  let t = Date.now();
  const offers = await duffel.search({
    origin: 'SYD',
    destination: 'LHR',
    departureDate: '2026-09-15',
    returnDate: '2026-09-25',
    cabinClass: 'economy',
  });
  const carriers = new Set(offers.map((o) => o.owner.iata_code));
  console.log(`   ${offers.length} offers / ${carriers.size} carriers in ${ms(t)}`);

  const withCabin = offers.filter((o) =>
    o.slices.every((s) => s.segments.every((g) => g.passengers.every((p) => p.cabin_class))),
  ).length;
  console.log(`   cabin_class present on ${withCabin}/${offers.length}`);

  const underCap = offers
    .filter((o) => toMinorUnits(o.total_amount) <= CAP_MINOR)
    .filter((o) => o.slices.every((s) => s.segments.every((g) => g.passengers.every((p) => p.cabin_class === 'economy'))))
    .sort((a, b) => toMinorUnits(a.total_amount) - toMinorUnits(b.total_amount));
  console.log(`   ${underCap.length} economy offers at or under AUD 1300`);
  for (const o of underCap.slice(0, 3)) console.log(`     ${o.owner.name} ${o.total_amount} ${o.total_currency}`);

  if (underCap.length === 0) throw new Error('no compliant offer — cannot continue smoke test');

  // -- Duffel refresh + hold, falling back down the compliant list -----------
  // Some airlines refuse hold orders with `422 invalid_order_create_type`, and nothing
  // in the offer says which. Mirrors the orchestrator's fallback.
  step('Duffel refresh + hold (with fallback)');
  t = Date.now();
  let order: Awaited<ReturnType<typeof duffel.createHoldOrder>> | null = null;
  for (const candidate of underCap) {
    const refreshed = await duffel.refreshOffer(candidate.id);
    const drift = refreshed.total_amount === candidate.total_amount ? 'none' : 'PRICE MOVED';
    try {
      order = await duffel.createHoldOrder(
        refreshed.id,
        {
          title: 'mr',
          givenName: 'Test',
          familyName: 'Traveller',
          bornOn: '1990-01-01',
          gender: 'm',
          phoneNumber: '+61400000000',
          email: 'traveler@travelguard24.vercel.app',
        },
        { internal_booking_ref: 'TG24-SMOKE', policy_decision_id: 'smoke' },
      );
      console.log(`   ${candidate.owner.name} ${refreshed.total_amount} — HELD (drift: ${drift})`);
      break;
    } catch (err) {
      console.log(`   ${candidate.owner.name} ${refreshed.total_amount} — refused: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
  }
  if (!order) throw new Error('no compliant offer could be held');
  console.log(`   PNR ${order.bookingReference} · ${order.totalAmount} ${order.totalCurrency} in ${ms(t)}`);
  console.log(`   awaiting_payment=${order.awaitingPayment} · required_by=${order.paymentRequiredBy}`);
  console.log('   left UNPAID deliberately — it will expire');

  // -- Prava session (free) --------------------------------------------------
  step('Prava create-session');
  t = Date.now();
  const session = await prava.createSession({
    totalAmount: order.totalAmount,
    currency: order.totalCurrency,
    externalOrderRef: order.id,
    productId: order.bookingReference,
    description: `Flight SYD-LHR return, economy, PNR ${order.bookingReference}`,
    userId: 'test_user_002',
    userEmail: 'traveler@travelguard24.vercel.app',
    cardId: '',
  });
  console.log(`   ${session.sessionId} in ${ms(t)}`);
  console.log(`   expires ${session.expiresAt}`);
  console.log(`   mandate amount ${order.totalAmount} — equals the order total, not the 1300.00 cap`);

  // -- Prava payment-result (free) -------------------------------------------
  step('Prava payment-result (pre-passkey)');
  const result = await prava.getPaymentResult(session.sessionId);
  console.log(`   status=${result.status} · credential=${result.credential ? 'present' : 'null (expected)'}`);

  step(`done in ${ms(started)} — no quota consumed, nothing paid`);
  console.log(`   abandon: session expires by itself; hold ${order.bookingReference} expires too`);
}

main().catch((err: unknown) => {
  console.error('\nSMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
