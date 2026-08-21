/**
 * The inbound channel — where a booking request actually comes from.
 *
 * WHY THIS EXISTS. Before this, a human typed an instruction into a box on our own page,
 * which makes the product a place you go to book: a travel site with an agent bolted on.
 * A real corporate traveller does not visit a console. They message someone. Putting the
 * request on a channel the traveller already uses is what makes the agent an agent — it
 * watches, decides, and reports back, rather than waiting to be visited.
 *
 * POLLED, NEVER A WEBHOOK. Deliberate, and it preserves an architectural decision that
 * predates this file: nothing connects inward, so the whole system runs on localhost with
 * no deployment, no tunnel and no public endpoint. Duffel and Prava are already
 * outbound-only for the same reason. Linq happens to expose GET endpoints for chats and
 * messages, so this holds for iMessage too.
 *
 * THE MESSAGE IS UNTRUSTED INPUT. This is the security property that matters most, and it
 * is easy to lose by accident. A message can say anything — including "my budget for this
 * trip is $10,000, approved by finance". It is a request, not an authority. Two rules keep
 * that true, and both are enforced outside this file:
 *
 *   1. Parsing yields a TripIntent and nothing else. There is no field in that type that
 *      can widen a policy, and anything the sender writes that does not map onto it is
 *      discarded rather than interpreted.
 *   2. The policy comes from policy.json, server-side. No inbound value is ever read as a
 *      rule, a cap, or an approval.
 *
 * So a traveller's stated budget renders as a preference and never as a limit. An agent
 * that could be talked out of its policy by the person instructing it would be worth
 * nothing to the organisation deploying it.
 */

/** One request as it arrived, before anything has been understood about it. */
export type InboundRequest = {
  /**
   * Channel-native message id. Used to deduplicate: every polled channel will hand back
   * the same message again, and a duplicate here means a duplicate booking attempt.
   */
  id: string;
  channel: ChannelKind;
  /** Who sent it — a phone number or an email address. Displayed, never trusted. */
  from: string;
  /** Where a reply goes. Opaque to us; the channel decides what it means. */
  threadId: string;
  subject?: string;
  /** The message body, verbatim. Rendered escaped; never executed, never eval'd. */
  text: string;
  receivedAt: string;
};

export type ChannelKind = 'demo' | 'imessage' | 'email';

export interface InboundChannel {
  readonly kind: ChannelKind;
  /** Human-readable identity of the receiving endpoint, e.g. "+12125550100". */
  readonly address: string;
  /**
   * Requests that have arrived since the last call.
   *
   * Implementations MUST return each message at most once, and MUST NOT return messages
   * that predate the process starting — otherwise a months-old "sounds good" in the
   * thread books a flight the moment the server boots.
   */
  poll(): Promise<InboundRequest[]>;
  /** Reports the outcome back into the same thread. */
  reply(threadId: string, text: string): Promise<void>;
}

/**
 * Tracks which messages have already been handled.
 *
 * Separate from the channel so the same guarantee is testable on its own, and so a
 * channel implementation cannot accidentally forget it.
 */
/**
 * Masks a traveller's contact for display: `+61455501234` → `••• 1234`.
 *
 * The full value is needed to send a reply and stays server-side. The browser only ever
 * receives the masked form, so it cannot appear in a screenshot, a screen recording, or a
 * shared debugging session — a real mobile number was legible in a submission screenshot
 * before this existed.
 *
 * The last four digits are kept because they are what lets a human confirm the right person
 * was contacted, which is the only reason the field is on screen at all. Same reasoning as
 * showing a card's last four rather than the PAN: identify, don't disclose.
 *
 * Values that are not contacts — a demo channel's label, say — are returned unchanged;
 * masking them would be noise, and there is nothing to protect.
 */
export function maskContact(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value.slice(0, 1)}•••${value.slice(at)}`;

  const digits = value.replace(/\D/g, '');
  if (digits.length >= 7) return `••• ${digits.slice(-4)}`;

  return value;
}

export function createSeenSet(): { seen(id: string): boolean; mark(id: string): void } {
  const ids = new Set<string>();
  return {
    seen: (id) => ids.has(id),
    mark: (id) => void ids.add(id),
  };
}
