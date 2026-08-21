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
import { composeAck, composeApproval, composeReply, composeUnclear } from '../channel/outcome.js';
import { maskContact } from '../channel/types.js';
import type { InboundChannel, InboundRequest } from '../channel/types.js';
import { createDuffelClient } from '../duffel/client.js';
import { createPravaClient } from '../prava/client.js';
import { createSimulatedMerchant } from '../merchant/simulated-merchant.js';
import { createHashChainAudit } from '../audit/hash-chain.js';
import { bookTrip } from '../orchestrator/orchestrator.js';
import { evaluate } from '../policy/engine.js';
import { createSensoClient, resolvePolicy } from '../policy/senso.js';
import type { Policy } from '../policy/types.js';
import type { Clock } from '../orchestrator/ports.js';
import { completeWithPolicyCabin, createMockIntentParser } from '../agent/intent.js';
import {
  applyTamper,
  isTamperMode,
  instrumentAudit,
  instrumentDuffel,
  instrumentEvaluate,
  instrumentMerchant,
  instrumentPrava,
  type TamperMode,
  type Emit,
  type UiEvent,
} from './events.js';

// Overridable so a second instance can be run against the same code without disturbing
// a window that is already open — closing the demo page to test something is how you
// lose a session mid-flow.
const PORT = Number(process.env.PORT ?? 3000);
const ROOT = new URL('../../', import.meta.url);

/**
 * PUBLIC MODE — the hosted instance judges can open and try.
 *
 * It runs discovery and the policy gate against live inventory, writes the audit entry,
 * and stops. It never reserves a seat and never requests a mandate, so a stranger cannot
 * spend anything and cannot consume the sandbox allowance.
 *
 * The guarantee is structural, not a flag: this deployment is given **no Prava credentials
 * at all**, so even a bug that reached the payment branch would have nothing to pay with.
 *
 * Loopback stays the DEFAULT. A platform that must bind a public interface has to say so
 * explicitly, because "nothing connects inward" is a claim the README makes and it must
 * remain true of every instance that has not opted out.
 */
const PUBLIC_MODE = (process.env['PUBLIC_DEMO'] ?? '') === '1';
const HOST = process.env['HOST'] ?? (PUBLIC_MODE ? '0.0.0.0' : '127.0.0.1');

const localPolicy = JSON.parse(readFileSync(fileURLToPath(new URL('policy.json', ROOT)), 'utf8')) as Policy;

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

// ---------------------------------------------------------------------------
// Where the RULES come from.
//
// `policy.json` restates rules that actually live in a signed document. When Senso is
// configured, the rules are retrieved from that document instead, so the audit trail cites
// the clause that authorises the spend rather than a literal a developer typed.
//
// This cannot widen the policy and cannot fail the run — see `policy/senso.ts`. Resolution
// happens once, at startup, so a booking never waits on it.
// ---------------------------------------------------------------------------
const sensoKey = process.env['SENSO_API_KEY'] ?? env['SENSO_API_KEY'] ?? '';
const resolvedPolicy = await resolvePolicy({
  local: localPolicy,
  client: sensoKey ? createSensoClient(sensoKey) : undefined,
});
const policy = resolvedPolicy.policy;
const policyProvenance = resolvedPolicy.provenance;

{
  const p = policyProvenance;
  const where = p.source === 'senso' ? `senso (${p.citations.join('; ') || 'no citations returned'})` : `policy.json (${p.reason})`;
  console.log(`policy ${policy.version} from ${where}`);
  if (p.tightened.length > 0) console.log(`  tightened: ${p.tightened.join(', ')}`);
  if (p.rejected?.length) console.log(`  rejected retrieval: ${p.rejected.join(', ')}`);
  if (p.detail) console.log(`  detail: ${p.detail}`);
}

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
 * Demo affordance, set from the screen and applied to the next run.
 *
 * It lives here rather than travelling with the request because a request now arrives from
 * a phone and starts on its own — there is no longer a moment where the screen is asked
 * for permission and could carry it along.
 */
let tamperMode: TamperMode = 'none';

/**
 * Reads a JSON request body safely.
 *
 * Two things this guards, both of which used to be able to take the server down mid-demo:
 * an unguarded `JSON.parse` inside an `end` handler throws where nothing catches it and
 * kills the process, and an unbounded `data` handler will accumulate whatever it is sent.
 * A malformed body is answered with a 400, not a crash.
 */
const MAX_BODY_BYTES = 64 * 1024;

function readJsonBody(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  onBody: (body: Record<string, unknown>) => void,
): void {
  let raw = '';
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) {
      aborted = true;
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'body too large' }));
      req.destroy();
    }
  });

  req.on('end', () => {
    if (aborted) return;
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
    }
    onBody(body);
  });
}

async function runBooking(request: InboundRequest, tamper: TamperMode): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = loadConfig(undefined, { requirePrava: !PUBLIC_MODE });

    // The approval message names the airline, which is only known once a hold succeeds —
    // and after a fallback it is not the carrier the gate first chose. Captured off the
    // event stream so the orchestrator stays unaware of any of this.
    let heldCarrier = '';
    const emit: Emit = (event) => {
      if (event.type === 'held') heldCarrier = event.carrier;
      broadcast(event);
    };

    // The message is the only input. Everything downstream — including which cabin gets
    // searched, and therefore whether the policy gate blocks — comes from what the
    // traveller actually said. Nothing in it can alter the policy it is judged by: the
    // parse yields a TripIntent and the rules come from policy.json, server-side.
    const instruction = request.text;
    emit({ type: 'instructed', text: instruction });
    // An unstated cabin is deduced from the policy when the policy permits exactly one —
    // asking the traveller to name the only legal option is asking them to recite the
    // policy. Anything genuinely ambiguous is still asked for. See `completeWithPolicyCabin`.
    const { result: parsed, derivedCabin } = completeWithPolicyCabin(
      await intentParser.parse(instruction),
      policy.allowedCabinClasses,
    );

    // An incomplete request is REFUSED, not completed with defaults.
    //
    // This is the earliest of the three refusal points and the only one that never reaches
    // a vendor: no search, no gate, no audit entry, because nothing was decided about a
    // purchase. It exists because the opposite behaviour was one passkey tap away from
    // charging a traveller for a route they never named.
    if (!parsed.complete) {
      const text = composeUnclear(parsed.missing);
      emit({ type: 'unclear', missing: parsed.missing, heard: parsed.heard, text });
      await replyTo(request).reply(request.threadId, text);
      emit({ type: 'finished', status: 'REQUEST_INCOMPLETE', detail: { missing: parsed.missing } });
      return;
    }

    const intent = parsed.intent;
    emit({ type: 'understood', intent, ...(derivedCabin ? { derivedCabin } : {}) });

    // Acknowledge before searching. The traveller has just messaged a number and would
    // otherwise hear nothing for twenty seconds — and restating the interpretation is how
    // they catch a misread before it costs anything. It asks for nothing: looking is free.
    const ack = composeAck(intent, { org: policy.org, derivedCabin });
    await replyTo(request).reply(request.threadId, ack);
    emit({ type: 'acknowledged', text: ack });

    const duffel = instrumentDuffel(
      createDuffelClient({ baseUrl: config.duffelBaseUrl, apiKey: config.duffelApiKey }),
      emit,
    );

    const realPrava = createPravaClient({
      baseUrl: config.pravaBaseUrl,
      secretKey: config.pravaSecretKey,
      merchantName: 'TravelGuard24',
      merchantUrl: 'https://travelguard24.vercel.app',
      merchantCountry: 'AU',
    });

    // How the approval reaches the human.
    //
    // For a request that arrived from a real channel, the link goes back into the same
    // thread: the traveller is holding the device the passkey is bound to, and they never
    // leave Messages. Verified on an iPhone — the checkout renders, the enrolled card is
    // pre-selected, and Face ID satisfies the WebAuthn step in one tap.
    //
    // For a rehearsal on the demo channel there is no phone, so the checkout opens locally
    // instead. Never both: a second window holding the same session is the tab collision
    // that has broken runs before.
    const deliverApproval = async (url: string, amount: string, currency: string): Promise<string | null> => {
      if (request.channel === 'demo') {
        // Opening a browser only makes sense where a human is sitting in front of one.
        // On a hosted Linux box `cmd` does not exist, and a failed spawn emits an `error`
        // event with nothing listening — an unhandled event takes the process down. That
        // would kill the run AFTER a seat was held and a mandate requested, i.e. at the
        // worst possible moment.
        //
        // Nothing is lost by skipping it: `awaiting_passkey` already carries `iframeUrl`,
        // and the screen renders its own button from that. The spawn is a convenience for
        // a local rehearsal, never the only route to the checkout.
        if (process.platform === 'win32') {
          const child = spawn('cmd', ['/c', 'start', 'chrome', url], { stdio: 'ignore', detached: true });
          child.on('error', () => {});
          child.unref();
        }
        return null;
      }
      const selected = { carrier: { name: heldCarrier || 'Your airline' }, totalAmount: amount, currency };
      await replyTo(request).reply(request.threadId, composeApproval(selected, url));
      // Display only — the reply has already been sent using the real value.
      return maskContact(request.from);
    };

    const prava = instrumentPrava(realPrava, emit, deliverApproval);

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
          givenName: 'Test',
          familyName: 'Traveller',
          bornOn: '1990-01-01',
          gender: 'm',
          phoneNumber: '+61491570006',
          email: 'traveler@travelguard24.vercel.app',
        },
        policy,
        userId: 'test_user_002',
        userEmail: 'traveler@travelguard24.vercel.app',
        cardId: config.pravaCardId,
        gateOnly: PUBLIC_MODE,
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
    broadcast({ type: 'replied', channel: target.kind, to: maskContact(request.from), text, delivered: true });
  } catch (err) {
    broadcast({
      type: 'replied',
      channel: target.kind,
      to: maskContact(request.from),
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
          broadcast({ type: 'arrived', request: { ...request, from: maskContact(request.from) } });
          // Proceeds on its own. Searching and gating spend nothing, so there is nothing
          // to ask permission for yet — the only approval is the passkey, and that is
          // requested later, in the traveller's own thread, once there is an amount.
          void runBooking(request, tamperMode);
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

  if (url.pathname === '/policy') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Provenance rides along so the screen can say where the rules came from. It is a
    // report of what startup already resolved, not a live check — the column states the
    // source, and the Senso knowledge base is what evidences it.
    res.end(JSON.stringify({ ...policy, provenance: policyProvenance }));
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
    // A hosted instance sits behind a proxy that closes an idle connection, and the gap
    // between opening the page and sending a message is easily longer than that. The
    // symptom would be the worst kind: a visitor sends a request and the screen never
    // moves, because the stream died while nothing was happening. A comment frame is
    // ignored by EventSource and keeps the connection alive.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
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
    readJsonBody(req, res, (body) => {
      const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
      demoChannel.inject(text || 'Book me SYD to LHR return, 15-25 Sept, economy');
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ injected: true }));
    });
    return;
  }

  // Arms the demo affordance for the next run. A request now arrives from a phone and
  // starts on its own, so this can no longer ride along with a confirmation.
  if (url.pathname === '/tamper' && req.method === 'POST') {
    // Meaningless in public mode — the redemption step is never reached — and it is a
    // server-side global, so leaving it reachable would let one visitor arm a mode that
    // silently changes what the next visitor sees.
    if (PUBLIC_MODE) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not available on the public demo' }));
      return;
    }
    readJsonBody(req, res, (body) => {
      // Validated rather than cast: an unrecognised mode must mean "no tampering", never
      // an accidental rejection of a real booking.
      tamperMode = isTamperMode(body['mode']) ? body['mode'] : 'none';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tamper: tamperMode }));
    });
    return;
  }

  res.writeHead(404);
  res.end('not found');
// Loopback ONLY, explicitly. `listen(PORT)` alone binds 0.0.0.0, which on a shared venue
// network exposes /simulate — a booking trigger — and /tamper to anyone on the same WiFi.
// "Nothing connects inward" is a claim this file makes at the top and the README repeats;
// this is what makes it true rather than merely intended.
}).listen(PORT, HOST, () => {
  console.log(`TravelGuard24 demo  ->  http://${HOST}:${PORT}`);
  console.log(`policy:  ${policy.org} · cap ${(policy.budgetCapMinor / 100).toFixed(2)} ${policy.currency}`);
  console.log(`channel: ${channel.kind} (${channel.address})`);
  if (PUBLIC_MODE) {
    console.log('mode:    PUBLIC — gate only. No hold, no mandate, no payment.');
    if (process.env['MERCHANT_SECRET_KEY']) {
      console.warn('  WARNING: a Prava secret is present in a public deployment. Remove it.');
    }
  }
  if (wantsIMessage && !linqKey) console.warn('CHANNEL=imessage but LINQ_API_KEY is missing — using the demo channel');
  void watch();
});
