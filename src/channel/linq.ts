/**
 * Linq — real iMessage, polled.
 *
 * Linq documents webhooks as the way to receive messages, which would have meant a public
 * HTTPS endpoint and therefore a tunnel or a deployment. It also exposes
 * `GET /chats` and `GET /chats/{id}/messages`, so we poll instead and nothing connects
 * inward. That keeps the whole system localhost-only, the same way Duffel and Prava are.
 *
 * NO SANDBOX EXISTS. Every send is a real message to a real handset. There is no dry run,
 * so the send path is exercised deliberately and never in a loop.
 */

import { request } from '../http.js';
import { createSeenSet, type InboundChannel, type InboundRequest } from './types.js';

type LinqPart = { type: string; value?: string };
type LinqMessage = {
  id: string;
  chat_id: string;
  from: string;
  is_from_me: boolean;
  sent_at?: string;
  created_at: string;
  parts?: LinqPart[];
};
type LinqChat = { id: string; display_name?: string };

export type LinqOptions = {
  apiKey: string;
  baseUrl?: string;
  /**
   * Messages at or before this instant are treated as already handled.
   *
   * Without it, the first poll replays the entire thread history and books a flight off
   * whatever the last message happened to say. Defaults to process start.
   */
  since?: Date;
};

/** Concatenates the text parts. Media and link parts carry no instruction, so they are dropped. */
function textOf(message: LinqMessage): string {
  return (message.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.value === 'string')
    .map((p) => (p.value ?? '').trim())
    .join(' ')
    .trim();
}

export function createLinqChannel(opts: LinqOptions): InboundChannel {
  const baseUrl = opts.baseUrl ?? 'https://api.linqapp.com/api/partner/v3';
  const headers = { Authorization: `Bearer ${opts.apiKey}` };
  const since = (opts.since ?? new Date()).getTime();
  const seen = createSeenSet();

  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) =>
    request<T>({
      method,
      url: `${baseUrl}${path}`,
      headers,
      vendor: 'Linq',
      ...(body !== undefined ? { body } : {}),
    });

  return {
    kind: 'imessage',
    address: 'iMessage',

    async poll(): Promise<InboundRequest[]> {
      const { chats } = await call<{ chats: LinqChat[] }>('GET', '/chats');
      const arrived: InboundRequest[] = [];

      for (const chat of chats ?? []) {
        const { messages } = await call<{ messages: LinqMessage[] }>('GET', `/chats/${chat.id}/messages`);

        for (const message of messages ?? []) {
          // Our own replies come back through the same endpoint. Acting on them would
          // book a flight in response to the confirmation of a flight.
          if (message.is_from_me) continue;
          if (seen.seen(message.id)) continue;

          const at = new Date(message.sent_at ?? message.created_at);
          // Mark history as handled without acting on it, so a restart is not a booking.
          if (at.getTime() <= since) {
            seen.mark(message.id);
            continue;
          }

          const text = textOf(message);
          seen.mark(message.id);
          // A bare reaction or an image has no instruction in it.
          if (!text) continue;

          arrived.push({
            id: message.id,
            channel: 'imessage',
            from: message.from,
            threadId: chat.id,
            text,
            receivedAt: at.toISOString(),
          });
        }
      }

      // Oldest first, so a burst is handled in the order the traveller sent it.
      return arrived.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
    },

    async reply(threadId: string, text: string): Promise<void> {
      // Parts nest under `message` on the way out, even though they arrive top-level on
      // a read. Sending `{ parts: [...] }` returns `1005 at least one message part is
      // required`, which reads as "your part is malformed" rather than "wrong envelope".
      await call('POST', `/chats/${threadId}/messages`, {
        message: { parts: [{ type: 'text', value: text }] },
      });
    },
  };
}
