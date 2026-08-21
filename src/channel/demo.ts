/**
 * A channel with no vendor behind it.
 *
 * This is not a stub standing in for the real thing until the real thing works — Linq
 * works. It is the channel the demo is recorded on, deliberately:
 *
 *   - Recording has to be reproducible. A take that depends on a handset, a carrier and
 *     Apple's delivery timing is a take that can fail for reasons that have nothing to do
 *     with the product.
 *   - Linq has no sandbox, so every rehearsal on it is a real message to a real phone.
 *
 * Replies are kept rather than sent, so the exact text that would have gone to the
 * traveller can be shown on screen and checked without messaging anyone.
 */

import type { InboundChannel, InboundRequest } from './types.js';

export type DemoChannel = InboundChannel & {
  /** Drops a message into the queue as though a traveller had just sent it. */
  inject(text: string, from?: string): InboundRequest;
  /** Replies that would have been sent, newest last. */
  sent(): Array<{ threadId: string; text: string }>;
};

export function createDemoChannel(): DemoChannel {
  const pending: InboundRequest[] = [];
  const outbox: Array<{ threadId: string; text: string }> = [];
  let n = 0;

  return {
    kind: 'demo',
    address: 'demo',

    inject(text, from = '+61455501234') {
      const req: InboundRequest = {
        id: `demo-${++n}`,
        channel: 'demo',
        from,
        threadId: 'demo-thread',
        text,
        receivedAt: new Date().toISOString(),
      };
      pending.push(req);
      return req;
    },

    async poll() {
      return pending.splice(0, pending.length);
    },

    async reply(threadId, text) {
      outbox.push({ threadId, text });
    },

    sent: () => [...outbox],
  };
}
