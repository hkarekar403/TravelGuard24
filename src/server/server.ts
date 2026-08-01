/**
 * Local demo server. Localhost only — nothing connects inward.
 *
 *   npx tsx src/server/server.ts     ->  http://localhost:3000
 *
 * Serves one page and streams booking progress over SSE. No framework, no build step:
 * a broken bundler at 2am is a worse risk than a hand-rolled 120-line server.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadConfig } from '../config.js';
import { createDuffelClient } from '../duffel/client.js';
import { createPravaClient } from '../prava/client.js';
import { createSimulatedMerchant } from '../merchant/simulated-merchant.js';
import { createHashChainAudit } from '../audit/hash-chain.js';
import { bookTrip } from '../orchestrator/orchestrator.js';
import { evaluate } from '../policy/engine.js';
import type { Policy } from '../policy/types.js';
import type { Clock } from '../orchestrator/ports.js';
import {
  applyTamper,
  instrumentAudit,
  instrumentDuffel,
  instrumentEvaluate,
  instrumentMerchant,
  instrumentPrava,
  type TamperMode,
  type UiEvent,
} from './events.js';

const PORT = 3000;
const ROOT = new URL('../../', import.meta.url);

const policy = JSON.parse(readFileSync(fileURLToPath(new URL('policy.json', ROOT)), 'utf8')) as Policy;

const clock: Clock = { now: () => new Date(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Connected browsers. One is the normal case; more is harmless. */
const clients = new Set<import('node:http').ServerResponse>();
let running = false;

function broadcast(event: UiEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) c.write(frame);
}

type BookBody = {
  cabinClass?: string;
  /** Demo affordance: deliberately corrupt the redemption so the guardrail visibly bites. */
  tamper?: TamperMode;
};

async function runBooking(body: BookBody): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = loadConfig();
    const emit = broadcast;

    const duffel = instrumentDuffel(
      createDuffelClient({ baseUrl: config.duffelBaseUrl, apiKey: config.duffelApiKey }),
      emit,
    );

    const realPrava = createPravaClient({
      baseUrl: config.pravaBaseUrl,
      secretKey: config.pravaSecretKey,
      merchantName: 'TravelGuard24',
      merchantUrl: 'https://travelguard24-demo.vercel.app',
      merchantCountry: 'AU',
    });

    const prava = instrumentPrava(
      {
        ...realPrava,
        async createSession(req) {
          const session = await realPrava.createSession(req);
          // Opening the checkout is the passkey step. On screen it is one tap.
          spawn('cmd', ['/c', 'start', 'chrome', session.iframeUrl], { stdio: 'ignore', detached: true }).unref();
          return session;
        },
      },
      emit,
    );

    const merchant = instrumentMerchant(
      applyTamper(createSimulatedMerchant({ merchantName: 'TravelGuard24' }), body.tamper ?? 'none'),
      emit,
    );
    const audit = instrumentAudit(createHashChainAudit(clock), emit);

    const outcome = await bookTrip(
      {
        search: {
          origin: 'SYD',
          destination: 'LHR',
          departureDate: '2026-09-15',
          returnDate: '2026-09-25',
          cabinClass: body.cabinClass ?? 'economy',
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
        cardId: '',
      },
      { duffel, prava, merchant, audit, clock, evaluate: instrumentEvaluate(evaluate, emit) },
    );

    // `decided` already fired from the instrumented gate, at the moment the decision was
    // actually made — do not re-broadcast it here or it lands after the payment.
    if (outcome.status === 'CONFIRMED') {
      broadcast({ type: 'ticketed', pnr: outcome.pnr, eTicketNumber: outcome.eTicketNumber });
    }
    broadcast({ type: 'finished', status: outcome.status, detail: outcome });
  } catch (err) {
    broadcast({ type: 'finished', status: 'ERROR', detail: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(readFileSync(fileURLToPath(new URL('public/index.html', ROOT))));
    return;
  }

  if (url.pathname === '/policy') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(policy));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/book' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as BookBody;
      void runBooking(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`TravelGuard24 demo  ->  http://localhost:${PORT}`);
  console.log(`policy: ${policy.org} · cap ${(policy.budgetCapMinor / 100).toFixed(2)} ${policy.currency}`);
});
