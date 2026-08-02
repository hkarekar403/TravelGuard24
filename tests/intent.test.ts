/**
 * The mock intent parser.
 *
 * These exist because the first version got all three demo phrasings wrong in ways that
 * only showed up when read aloud: `sin` matched inside "business", "to London from Sydney"
 * came out reversed, and a single airport mention was taken as the origin.
 */

import { describe, expect, it } from 'vitest';
import { completeWithPolicyCabin, createMockIntentParser } from '../src/agent/intent.js';

const parser = createMockIntentParser({ year: 2026 });

/**
 * What the parser understood, whether or not the request was complete.
 *
 * Field-level tests below deliberately supply one thing at a time, which is by definition
 * an incomplete request — so they assert against what was *heard*. Completeness is its own
 * describe block, because it is a different property.
 */
const heard = async (text: string) => {
  const r = await parser.parse(text);
  return r.complete ? r.intent : r.heard;
};

/** Asserts the request was complete, and returns the intent. */
const complete = async (text: string) => {
  const r = await parser.parse(text);
  if (!r.complete) throw new Error(`expected a complete parse; missing: ${r.missing.join(', ')}`);
  return r.intent;
};

/** Asserts the request was refused, and returns what was missing. */
const missing = async (text: string) => {
  const r = await parser.parse(text);
  if (r.complete) throw new Error('expected an incomplete parse, but every field was found');
  return r.missing;
};

describe('dates', () => {
  // Both of these were sent to the agent on camera and both produced the wrong trip.
  it('does not read a day out of a four-digit year', async () => {
    // "2026 to 28th" used to parse as a 26 -> 28 range, booking the wrong departure.
    const i = await heard(
      'Book me a Sydney London return flight for 25 September 2026 to 28th September 2026 for economy class.',
    );
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads a day+month on both ends', async () => {
    // Previously matched nothing and fell back to the demo defaults, silently.
    const i = await heard('Book me SYD to LHR, 25 September to 28 September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('still reads the short range form the demo uses', async () => {
    const i = await heard('Book me SYD to LHR return, 15-25 Sept, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-15', '2026-09-25']);
  });

  it('reads ordinals with the month named once', async () => {
    const i = await heard('SYD to LHR, 25th to 28th September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads the month-first form', async () => {
    const i = await heard('SYD to LHR, Sept 15-25, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-15', '2026-09-25']);
  });

  it('spans two different months', async () => {
    const i = await heard('SYD to LHR, 25 Sept to 3 Oct, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-10-03']);
  });

  it('rolls the return into the next year when the month goes backwards', async () => {
    const i = await heard('SYD to LHR, 28 December to 3 January, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-12-28', '2027-01-03']);
  });

  it('does not read money as a date', async () => {
    // "$1,200", "1500 AUD" and "10K" all contain digits that used to be reachable. Finding
    // no date is the correct outcome here, and it now refuses rather than inventing one.
    const i = await heard('Book me SYD to LHR economy, under $1,200 — finance approved 1500 AUD');
    expect([i.departureDate, i.returnDate]).toEqual([undefined, undefined]);
    expect(await missing('Book me SYD to LHR economy, under $1,200 — finance approved 1500 AUD')).toContain('dates');
  });

  // Dictation spells ordinals as words. "returning back on third October" was heard on a
  // real run and produced no date at all, so the request silently used the demo default.
  it('reads a spoken ordinal', async () => {
    const i = await heard('Book me a flight from Sydney to New York for 28th September returning back on third October');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-28', '2026-10-03']);
  });

  it('reads a compound spoken ordinal', async () => {
    const i = await heard('Sydney to London, twenty fifth of September to twenty eighth of September');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('does not let ordinal words break cabin detection', async () => {
    // Normalising the whole instruction would turn "first class" into "1th class".
    expect((await heard('first class SYD to LHR, 15-25 Sept')).cabinClass).toBe('first');
  });

  // The demo is driven by Siri dictation, which phrases dates differently from typing —
  // it says "the 25th OF September" where a keyboard says "25 September". Without the
  // filler word the day and month stop being adjacent and the date silently defaults.
  it('reads dictated "25th of September to 28th of September"', async () => {
    const i = await heard('Book me a Sydney to London return, 25th of September to 28th of September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads dictated "the 25th of September to the 28th of September 2026"', async () => {
    const i = await heard('Sydney to London, the 25th of September to the 28th of September 2026, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads dictated "September 25th to September 28th"', async () => {
    const i = await heard('Sydney to London, September 25th to September 28th, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads a return stated only as a bare ordinal', async () => {
    const i = await heard('Sydney to London on the 25th of September returning the 28th, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('refuses when no dates are given at all', async () => {
    expect(await missing('Book me SYD to LHR economy')).toEqual(['dates']);
  });
});

/**
 * The property that matters most, and the reason the parser was rewritten.
 *
 * A dictated message containing ONLY dates was previously completed into a Sydney→London
 * economy trip, priced against live inventory, and offered for passkey approval. The
 * traveller was one tap from paying for a route they had never named.
 */
describe('an incomplete request is refused, never completed', () => {
  it('refuses a message that is only dates — the failure seen on a real run', async () => {
    expect(await missing('25th of September to 28 September')).toEqual(['origin', 'destination', 'cabin']);
  });

  it('names every missing field, not just the first', async () => {
    expect(await missing('book me something')).toEqual(['origin', 'destination', 'dates', 'cabin']);
  });

  it('refuses a route with no dates', async () => {
    expect(await missing('Book me business class Sydney to London')).toEqual(['dates']);
  });

  it('refuses when only one date is given', async () => {
    // A one-way date is not a return trip, and half a range must not be completed.
    expect(await missing('Book me economy Sydney to London on 25 September')).toEqual(['dates']);
  });

  it('refuses when the cabin is unstated rather than assuming economy', async () => {
    expect(await missing('Sydney to London, 15-25 Sept')).toEqual(['cabin']);
  });

  it('still returns what it DID understand, so the screen can show it heard something', async () => {
    const r = await parser.parse('25th of September to 28 September');
    expect(r.complete).toBe(false);
    if (!r.complete) {
      expect(r.heard.departureDate).toBe('2026-09-25');
      expect(r.heard.origin).toBeUndefined();
    }
  });

  // Deduction, not a default: with an economy-only policy there is exactly one cabin the
  // agent could ever book, so requiring the traveller to name it asks them to recite the
  // policy. Two or more permitted cabins is genuinely ambiguous and is still asked for.
  it('derives the cabin when the policy permits exactly one', async () => {
    const r = await parser.parse('Get me a return ticket from Sydney to London 28 September to 5th October');
    const { result, derivedCabin } = completeWithPolicyCabin(r, ['economy']);
    expect(derivedCabin).toBe('economy');
    expect(result.complete).toBe(true);
    if (result.complete) {
      expect(result.intent.cabinClass).toBe('economy');
      expect([result.intent.departureDate, result.intent.returnDate]).toEqual(['2026-09-28', '2026-10-05']);
    }
  });

  it('still asks for the cabin when the policy permits more than one', async () => {
    const r = await parser.parse('Get me a return ticket from Sydney to London 28 September to 5th October');
    const { result, derivedCabin } = completeWithPolicyCabin(r, ['economy', 'premium_economy']);
    expect(derivedCabin).toBeNull();
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.missing).toEqual(['cabin']);
  });

  it('does not ask for a cabin the policy has already determined, but still asks for the rest', async () => {
    const r = await parser.parse('25th of September to 28 September');
    const { result } = completeWithPolicyCabin(r, ['economy']);
    expect(result.complete).toBe(false);
    if (!result.complete) expect(result.missing).toEqual(['origin', 'destination']);
  });

  it('never overrides a cabin the traveller actually stated', async () => {
    const r = await parser.parse('Book me business class Sydney to London, 25 Sept to 28 Sept');
    const { result, derivedCabin } = completeWithPolicyCabin(r, ['economy']);
    expect(derivedCabin).toBeNull();
    expect(result.complete).toBe(true);
    if (result.complete) expect(result.intent.cabinClass).toBe('business');
  });

  it('accepts a request that names everything', async () => {
    const i = await complete('Book me an economy flight Sydney to London, 25 September to 28 September');
    expect([i.origin, i.destination, i.departureDate, i.returnDate, i.cabinClass]).toEqual([
      'SYD', 'LHR', '2026-09-25', '2026-09-28', 'economy',
    ]);
  });
});

describe('stated budget', () => {
  // The point of capturing this is not the number, it is the ASSERTED AUTHORITY. The demo
  // beat is a traveller saying finance approved ten thousand and the gate using the org's
  // 1,300 cap regardless — which is only visible if the claim renders next to the cap.
  it('captures an approval the traveller asserts', async () => {
    const i = await heard(
      'Book me a Sydney London business class flight 25th September to 28th September, finance approved 10,000 AUD for this trip',
    );
    expect(i.statedBudget).toBe('10000');
  });

  it('captures "authorised" and "signed off" too', async () => {
    expect((await heard('SYD to LHR, my manager authorised 4,500 AUD')).statedBudget).toBe('4500');
    expect((await heard('SYD to LHR, finance signed off on 2000')).statedBudget).toBe('2000');
  });

  // Dictation chooses the currency form, and it does not choose consistently. "AU$10,000"
  // was what Siri produced on a recorded run, and it captured nothing — so the claim never
  // rendered beside the cap, which is the entire point of capturing it.
  it.each([
    ['finance approved AU$10,000', '10000'],
    ['finance approved A$10,000', '10000'],
    ['finance approved US$4,500', '4500'],
    ['finance approved $10,000', '10000'],
    ['finance approved 10,000 AUD', '10000'],
    ['finance approved 10000', '10000'],
  ])('captures %s', async (phrase, expected) => {
    expect((await heard(`Book me business class SYD to LHR, 25 to 28 September, ${phrase}`)).statedBudget).toBe(expected);
  });

  it('still captures the plain limit forms', async () => {
    expect((await heard('Book me SYD to LHR, under $1,200')).statedBudget).toBe('1200');
    expect((await heard('Book me SYD to LHR, budget of 1500')).statedBudget).toBe('1500');
  });

  it('is absent when the traveller names no number', async () => {
    expect((await heard('Book me SYD to LHR, 15-25 Sept, economy')).statedBudget).toBeUndefined();
  });
});

describe('route', () => {
  it('reads a plain "X to Y"', async () => {
    const i = await heard('Book me SYD to LHR return, 15-25 Sept, economy');
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('does not match an airport code inside another word', async () => {
    // `sin` sits inside "bu(sin)ess" and used to route a London trip via Singapore.
    const i = await heard("Book me business class SYD to LHR, 15-25 Sept - it's a long flight");
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('honours from/to markers over word order', async () => {
    const i = await heard('Need to get to London from Sydney, 15-25 Sept');
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('treats a single "to X" as the destination, not the origin', async () => {
    const i = await heard('get me to london');
    expect(i.destination).toBe('LHR');
    // No origin is invented to fill the gap; the request is refused instead.
    expect(i.origin).toBeUndefined();
    expect(await missing('get me to london')).toContain('origin');
  });
});

describe('cabin', () => {
  it.each([
    ['fly me business class to London', 'business'],
    ['premium economy please', 'premium_economy'],
    ['first class SYD to LHR', 'first'],
    ['SYD to LHR economy', 'economy'],
    // Dictation writes "economic" for "economy" — seen on a live run.
    ['Book me an economic class flight SYD to LHR', 'economy'],
    ['premium economic SYD to LHR', 'premium_economy'],
  ])('reads %s', async (text, expected) => {
    expect((await heard(text)).cabinClass).toBe(expected);
  });

  it('does not default to economy — an unstated cabin refuses the request', async () => {
    // Economy is the safest guess, which is exactly why defaulting was tempting. It still
    // means searching a cabin nobody asked for and presenting the result as the answer.
    const i = await heard('SYD to LHR, 15-25 Sept');
    expect(i.cabinClass).toBeUndefined();
    expect(await missing('SYD to LHR, 15-25 Sept')).toEqual(['cabin']);
  });
});

describe('dates', () => {
  it('reads a day range and a month', async () => {
    const i = await heard('SYD to LHR, 15-25 Sept');
    expect(i.departureDate).toBe('2026-09-15');
    expect(i.returnDate).toBe('2026-09-25');
  });

  it('accepts an en dash and the word "to"', async () => {
    expect((await heard('SYD to LHR, 15–25 September')).departureDate).toBe('2026-09-15');
    expect((await heard('SYD to LHR, 3 to 9 October')).returnDate).toBe('2026-10-09');
  });
});

describe("the traveller's stated budget", () => {
  it('is captured separately from the policy cap', async () => {
    // The traveller expresses a preference; the policy decides what is allowed. Keeping
    // them distinct is the point — the cap is never sourced from the instruction.
    const i = await heard('Need to get to London from Sydney, 15-25 Sept, under $1,200');
    expect(i.statedBudget).toBe('1200');
  });

  it('is absent when unstated', async () => {
    expect((await heard('SYD to LHR, 15-25 Sept')).statedBudget).toBeUndefined();
  });
});
