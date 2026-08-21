/**
 * Closes a Prava session left at `awaiting_result`.
 *
 *   npx tsx src/cli/close-session.ts <session_id> [APPROVED|DECLINED]
 *
 * WHY THIS EXISTS. A session whose credentials were issued but never reported sits open
 * with a live credential attached, and the next checkout for the same customer then runs
 * the `addCard` path — card typed on screen, ~170s — instead of the saved-card repeat flow.
 * On camera that destroys the "one tap, zero typing" claim.
 *
 * `report-status` is the only thing that reliably closes a session. `POST /revoke` returns
 * `200 {"success":true}` and changes nothing.
 *
 * Defaults to DECLINED, because the reason a session is usually left open is that something
 * refused it. Never prints the token or CVV.
 */

import { loadConfig } from '../config.js';
import { createPravaClient } from '../prava/client.js';

async function main(): Promise<void> {
  const sessionId = process.argv[2];
  const status = (process.argv[3] ?? 'DECLINED').toUpperCase();

  if (!sessionId) throw new Error('usage: close-session.ts <session_id> [APPROVED|DECLINED]');
  if (status !== 'APPROVED' && status !== 'DECLINED') throw new Error('status must be APPROVED or DECLINED');

  const config = loadConfig();
  const prava = createPravaClient({
    baseUrl: config.pravaBaseUrl,
    secretKey: config.pravaSecretKey,
    merchantName: 'TravelGuard24',
    merchantUrl: 'https://travelguard24.vercel.app',
    merchantCountry: 'AU',
  });

  const before = await prava.getPaymentResult(sessionId);
  console.log(`session  : ${sessionId}`);
  console.log(`status   : ${before.status}`);

  if (!before.credential) {
    console.log('no credential on this session — nothing to report, it is not holding one open');
    return;
  }
  console.log(`credential present (values not printed)`);

  const report = await prava.reportStatus(sessionId, before.credential, status);
  // NOTE: `visa_confirmation` reads SUCCESS even when reporting DECLINED — it describes
  // whether the REPORT was accepted, not whether the payment succeeded. Do not read it as
  // evidence that money moved.
  console.log(`reported : ${status} -> confirmed=${report.confirmed} visa=${report.visaConfirmation}`);

  const after = await prava.getPaymentResult(sessionId);
  console.log(`status   : ${after.status}`);
  // `completed` follows APPROVED, `failed` follows DECLINED. Both are terminal — the point
  // is that the session no longer holds a live credential open.
  const closed = after.status === 'completed' || after.status === 'failed';
  console.log(closed ? 'CLOSED — no longer holding a credential open' : 'still open — check the dashboard');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
