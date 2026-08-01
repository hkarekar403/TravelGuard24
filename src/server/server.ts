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

import { loadConfig, loadEnvFile } from '../config.js';
import { createDemoChannel } from '../channel/demo.js';
import { createLinqChannel } from '../channel/linq.js';
import { composeReply } from '../channel/outcome.js';
import type { InboundChannel, InboundRequest } from '../channel/types.js';
import { createDuffelClient } from '../duffel/client.js';
import { createPravaClient } from '../prava/client.js';
import { createSimulatedMerchant } from '../merchant/simulated-merchant.js';
import { createHashChainAudit } from '../audit/hash-chain.js';
import { bookTrip } from '../orchestrator/orchestrator.js';
import { evaluate } from '../policy/engine.js';
import type { Policy } from '../policy/types.js';
import type { Clock } from '../orchestrator/ports.js';
import { createMockIntentParser } from '../agent/intent.js';
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

// Overridable so a second instance can be run against the same code without disturbing
// a window that is already open — closing the demo page to test something is how you
// lose a session mid-flow.
const PORT = Number(process.env.PORT ?? 3000);
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

const intentParser = createMockIntentParser();

// ---------------------------------------------------------------------------
// Where requests come from.
//
// Default is the demo channel, deliberately — the recording has to be reproducible, and
// Linq has no sandbox, so every rehearsal on iMessage is a real message to a real phone.
// `CHANNEL=imessage` switches to the real thing.
// ---------------------------------------------------------------------------
const env = loadEnvFile();
const demoChannel = createDemoChannel();
const wantsIMessage = (process.env['CHANNEL'] ?? env['CHANNEL'] ?? 'demo') === 'imessage';
const linqKey = process.env['LINQ_API_KEY'] ?? env['LINQ_API_KEY'] ?? '';

const channel: InboundChannel =
  wantsIMessage && linqKey ? createLinqChannel({ apiKey: linqKey }) : demoChannel;

/**
 * Every channel being watched.
 *
 * The demo channel is always among them, even when a real one is active: rehearsing a
 * screen state should not require sending a real message to a real handset, and the
 * blocked path in particular gets re-run repeatedly while its layout is being settled.
 * An injected request is still labelled `demo` on screen, so it can never be mistaken for
 * something that actually arrived.
 */
const watched: InboundChannel[] = channel === demoChannel ? [demoChannel] : [demoChannel, channel];

/** Replies go back to the channel the request came in on, not to the active one. */
const replyTo = (request: InboundRequest): InboundChannel =>
  request.channel === 'demo' ? demoChannel : channel;

const POLL_MS = 1_500;

/**
 * Arrived, shown to the human, not yet confirmed.
 *
 * A booking is only ever started from one of these, so what runs always traces back to a
 * message that genuinely arrived — the UI cannot invent an instruction and post it.
 */
const awaiting = new Map<string, InboundRequest>();

async function runBooking(request: InboundRequest, tamper: TamperMode): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = loadConfig();
    const emit = broadcast;

    // The message is the only input. Everything downstream — including which cabin gets
    // searched, and therefore whether the policy gate blocks — comes from what the
    // traveller actually said. Nothing in it can alter the policy it is judged by: the
    // parse yields a TripIntent and the rules come from policy.json, server-side.
    const instruction = request.text;
    emit({ type: 'instructed', text: instruction });
    const intent = await intentParser.parse(instruction);
    emit({ type: 'understood', intent });

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
          // Opening the checkout is the passkey step. When a browser is watching it
          // opens the checkout itself, as a positioned popup, so the handoff reads as
          // a payment modal over the agent rather than a tab switch away from it.
          // Only when nothing is watching (CLI rehearsal) does the server open a tab —
          // otherwise the checkout would open twice, and a second window holding the
          // same session is exactly the tab collision that has broken runs before.
          if (clients.size === 0) {
            spawn('cmd', ['/c', 'start', 'chrome', session.iframeUrl], { stdio: 'ignore', detached: true }).unref();
          }
          return session;
        },
      },
      emit,
    );

    const merchant = instrumentMerchant(
      applyTamper(createSimulatedMerchant({ merchantName: 'TravelGuard24' }), tamper),
      emit,
    );
    const audit = instrumentAudit(createHashChainAudit(clock), emit);

    const outcome = await bookTrip(
      {
        search: {
          origin: intent.origin,
          destination: intent.destination,
          departureDate: intent.departureDate,
          returnDate: intent.returnDate,
          cabinClass: intent.cabinClass,
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

    // Close the loop in the traveller's own thread. Every terminating outcome gets a
    // reply, including the refusals — silence after "book me a flight" leaves someone
    // not knowing whether they have a seat or whether they have been charged.
    await notify(request, composeReply(outcome, { org: policy.org }));

    broadcast({ type: 'finished', status: outcome.status, detail: outcome });
  } catch (err) {
    broadcast({ type: 'finished', status: 'ERROR', detail: err instanceof Error ? err.message : String(err) });
  } finally {
    running = false;
  }
}

/**
 * Sends the outcome back, and shows on screen what was sent.
 *
 * A failure to notify must never fail the booking — the money has already moved, or
 * deliberately not moved, and neither is undone by a message not sending.
 */
async function notify(request: InboundRequest, text: string): Promise<void> {
  const target = replyTo(request);
  try {
    await target.reply(request.threadId, text);
    broadcast({ type: 'replied', channel: target.kind, to: request.from, text, delivered: true });
  } catch (err) {
    broadcast({
      type: 'replied',
      channel: target.kind,
      to: request.from,
      text,
      delivered: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Watches the channel.
 *
 * Polled, so nothing connects inward and this still runs on localhost with no tunnel.
 * A poll failure is logged and retried rather than thrown — a transient vendor error
 * must not silently stop the agent watching.
 */
async function watch(): Promise<void> {
  for (;;) {
    for (const source of watched) {
      try {
        for (const request of await source.poll()) {
          // One at a time. A second request arriving mid-booking is dropped rather than
          // queued: it would otherwise surface minutes later against a screen showing
          // someone else's booking.
          if (running) continue;
          awaiting.set(request.id, request);
          broadcast({ type: 'arrived', request });
        }
      } catch (err) {
        // Per source, so one vendor failing does not stop the others being watched.
        console.error(`${source.kind} poll failed:`, err instanceof Error ? err.message : err);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    // no-store, because the page is read from disk on every request and is edited
    // constantly. A cached copy produces the worst possible symptom: a screen that looks
    // current, silently missing the change you just made — and on a bad day, filmed.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(readFileSync(fileURLToPath(new URL('public/index.html', ROOT))));
    return;
  }

  // Parses an instruction and returns what the agent understood — and does nothing else.
  // No search, no vendor, no booking. It exists so the human confirms the agent's
  // INTERPRETATION rather than their own typing, which is the only version of a confirm
  // step that carries any information.
  if (url.pathname === '/understand' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      void (async () => {
        const { instruction } = (raw ? JSON.parse(raw) : {}) as { instruction?: string };
        const intent = await intentParser.parse(instruction?.trim() || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(intent));
      })();
    });
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

  // Who the agent is watching. The screen says so, because an agent that watches a
  // channel is a different product from a form that waits to be filled in.
  if (url.pathname === '/channel') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ kind: channel.kind, address: channel.address }));
    return;
  }

  // Rehearsal affordance: injects a message as though a traveller had sent it. Only
  // reaches the demo channel — it cannot fabricate an inbound iMessage, so what is on
  // screen during a real run always corresponds to a message that genuinely arrived.
  if (url.pathname === '/simulate' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const { text } = (raw ? JSON.parse(raw) : {}) as { text?: string };
      demoChannel.inject(text?.trim() || 'Book me SYD to LHR return, 15-25 Sept, economy');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ injected: true }));
    });
    return;
  }

  if (url.pathname === '/book' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as { requestId?: string; tamper?: TamperMode };
      const request = body.requestId ? awaiting.get(body.requestId) : undefined;
      if (!request) {
        // A booking must trace back to a message somebody actually sent.
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no such pending request' }));
        return;
      }
      awaiting.delete(request.id);
      void runBooking(request, body.tamper ?? 'none');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: true }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`TravelGuard24 demo  ->  http://localhost:${PORT}`);
  console.log(`policy:  ${policy.org} · cap ${(policy.budgetCapMinor / 100).toFixed(2)} ${policy.currency}`);
  console.log(`channel: ${channel.kind} (${channel.address})`);
  if (wantsIMessage && !linqKey) console.warn('CHANNEL=imessage but LINQ_API_KEY is missing — using the demo channel');
  void watch();
});
