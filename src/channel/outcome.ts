/**
 * What the agent says back, in the traveller's own thread.
 *
 * Pure — takes an outcome, returns text. No I/O, so every wording below is testable
 * without a vendor, a network or a passkey.
 *
 * THIS IS THE PRODUCT'S THESIS DELIVERED TO A HUMAN. The screen argues it to a judge; this
 * argues it to the person who asked. Three obligations shape the wording:
 *
 *   - A refusal must name the rule and the number. "Can't do that" is useless; "policy
 *     allows economy only, and the cheapest business fare is 5,804.08 over your cap" tells
 *     the traveller what to do next.
 *   - A refusal must say that nothing was spent, explicitly, and in the SAME WORDS every
 *     time: "Nothing was charged." The traveller's first worry on being declined is
 *     whether they have been charged anyway, and a phrase that varies between outcomes is
 *     one they have to read carefully to find. A test enforces this on every outcome
 *     except SETTLEMENT_FAILED, which is the one case where money genuinely did move.
 *   - No message ever carries a credential, a token, a CVV or a session id. These go to a
 *     phone, over a channel we do not control, and are screenshotted by users. The PNR is
 *     the only identifier a traveller needs, and it is already printable on a boarding pass.
 */

import type { BookingOutcome } from '../orchestrator/orchestrator.js';
import type { PolicyDecision, RuleId } from '../policy/types.js';

const RULE_LABEL: Record<RuleId, string> = {
  cabin_class: 'cabin class',
  vendor_allowlist: 'approved airlines',
  advance_purchase: 'advance purchase',
  budget_cap: 'budget cap',
};

/** "1202.75" + "AUD" -> "1,202.75 AUD". Never parses to float. */
function money(amount: string, currency: string): string {
  const [whole = '0', frac] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${frac ? `.${frac}` : ''} ${currency}`;
}

function blockedText(decision: PolicyDecision): string {
  const miss = decision.nearestMiss;
  const lines = [`I couldn't book that — it doesn't pass ${decision.policyVersion} travel policy.`, ''];

  if (miss) {
    const failed = miss.rules.filter((r) => !r.passed);
    for (const rule of failed) {
      // `detail` carries the amplification the engine already computed, e.g. the overage.
      lines.push(`• ${RULE_LABEL[rule.rule]}: ${rule.observed} — ${rule.detail ?? rule.expected}`);
    }
    lines.push('');
    lines.push(
      `Closest option was ${miss.carrier.name} at ${money(miss.totalAmount, miss.currency)}, ` +
        `and ${failed.length === 1 ? 'that rule' : 'those rules'} still failed.`,
    );
  }

  lines.push('');
  lines.push(`I checked ${decision.totalOffers} fares. None qualified, so I never requested payment. Nothing was charged.`);
  return lines.join('\n');
}

/**
 * Composes the reply.
 *
 * Every terminating outcome gets a message, including the ones that stop midway. Silence
 * after "book me a flight" is the worst possible behaviour: the traveller does not know
 * whether they have a seat, and does not know whether they have been charged.
 */
export function composeReply(outcome: BookingOutcome): string {
  switch (outcome.status) {
    case 'CONFIRMED': {
      const carrier = outcome.decision.selected?.carrier.name ?? 'your airline';
      return [
        `Booked. ${carrier}, confirmation ${outcome.pnr}.`,
        outcome.eTicketNumber ? `E-ticket ${outcome.eTicketNumber} issued.` : 'E-ticket issued.',
        '',
        `Charged ${money(outcome.amount, outcome.currency)} on a one-time credential locked to that exact amount.`,
        'It passed all four policy rules — the check ran before any payment was authorised.',
      ].join('\n');
    }

    case 'BLOCKED_BY_POLICY':
      return blockedText(outcome.decision);

    case 'NO_BOOKABLE_OFFER': {
      const carriers = [...new Set(outcome.attempts.map((a) => a.carrier))];
      // Negation has to be explicit. "the airline would hold it without immediate
      // payment" reads as the opposite of what happened.
      const who =
        carriers.length === 1 ? `${carriers[0]} wouldn't` : carriers.length === 0 ? "the airline wouldn't" : 'no airline would';
      return [
        `I found fares that passed policy, but ${who} hold a reservation without taking payment up front` +
          `${carriers.length > 1 ? ` (tried ${carriers.join(', ')})` : ''}.`,
        '',
        'Nothing was charged and nothing was booked. Worth trying different dates.',
      ].join('\n');
    }

    case 'PRICE_DRIFTED':
      return [
        `The fare moved while I was booking — quoted ${outcome.quoted}, the airline then wanted ${outcome.ordered}.`,
        '',
        "I stopped rather than authorise an amount nobody approved. Nothing was charged. Ask me again and I'll re-price it.",
      ].join('\n');

    case 'AUTHORISATION_TIMED_OUT':
      return [
        `Reservation ${outcome.pnr} is held, but the approval wasn't completed in time.`,
        '',
        'Nothing was charged. The reservation will expire on its own unless you ask me to try again.',
      ].join('\n');

    case 'AUTHORISATION_FAILED':
      return [
        `I couldn't get payment authorised for reservation ${outcome.pnr}.`,
        '',
        'Nothing was charged and no credential was issued. The reservation will expire unless we retry.',
      ].join('\n');

    case 'REDEMPTION_REJECTED':
      // The mandate refused the presentation. Say what protected them, without the detail
      // of which check fired — that is operator information, and it is in the audit log.
      return [
        `I stopped the payment for reservation ${outcome.pnr}.`,
        '',
        "The charge didn't match what you approved, so it was refused and reported as declined.",
        'Nothing was charged and the airline was never paid.',
      ].join('\n');

    case 'REPORT_REJECTED':
      return [
        `Payment for reservation ${outcome.pnr} wasn't confirmed by the card network.`,
        '',
        'Nothing was charged. The airline was not paid and the reservation will expire.',
      ].join('\n');

    case 'SETTLEMENT_FAILED':
      // The one outcome where money did move. Never soften this.
      return [
        `Your payment for reservation ${outcome.pnr} went through, but I couldn't pay the airline.`,
        '',
        'The ticket has not been issued. This is being resolved manually — you have not lost the money.',
      ].join('\n');
  }
}
