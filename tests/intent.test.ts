/**
 * The mock intent parser.
 *
 * These exist because the first version got all three demo phrasings wrong in ways that
 * only showed up when read aloud: `sin` matched inside "business", "to London from Sydney"
 * came out reversed, and a single airport mention was taken as the origin.
 */

import { describe, expect, it } from 'vitest';
import { createMockIntentParser } from '../src/agent/intent.js';

const parser = createMockIntentParser({ year: 2026 });

describe('dates', () => {
  // Both of these were sent to the agent on camera and both produced the wrong trip.
  it('does not read a day out of a four-digit year', async () => {
    // "2026 to 28th" used to parse as a 26 -> 28 range, booking the wrong departure.
    const i = await parser.parse(
      'Book me a Sydney London return flight for 25 September 2026 to 28th September 2026 for economy class.',
    );
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads a day+month on both ends', async () => {
    // Previously matched nothing and fell back to the demo defaults, silently.
    const i = await parser.parse('Book me SYD to LHR, 25 September to 28 September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
    expect(i.assumptions.join(' ')).not.toContain('dates not stated');
  });

  it('still reads the short range form the demo uses', async () => {
    const i = await parser.parse('Book me SYD to LHR return, 15-25 Sept, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-15', '2026-09-25']);
  });

  it('reads ordinals with the month named once', async () => {
    const i = await parser.parse('SYD to LHR, 25th to 28th September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads the month-first form', async () => {
    const i = await parser.parse('SYD to LHR, Sept 15-25, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-15', '2026-09-25']);
  });

  it('spans two different months', async () => {
    const i = await parser.parse('SYD to LHR, 25 Sept to 3 Oct, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-10-03']);
  });

  it('rolls the return into the next year when the month goes backwards', async () => {
    const i = await parser.parse('SYD to LHR, 28 December to 3 January, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-12-28', '2027-01-03']);
  });

  it('does not read money as a date', async () => {
    // "$1,200", "1500 AUD" and "10K" all contain digits that used to be reachable.
    const i = await parser.parse('Book me SYD to LHR economy, under $1,200 — finance approved 1500 AUD');
    expect(i.assumptions.join(' ')).toContain('dates not stated');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-15', '2026-09-25']);
  });

  // The demo is driven by Siri dictation, which phrases dates differently from typing —
  // it says "the 25th OF September" where a keyboard says "25 September". Without the
  // filler word the day and month stop being adjacent and the date silently defaults.
  it('reads dictated "25th of September to 28th of September"', async () => {
    const i = await parser.parse('Book me a Sydney to London return, 25th of September to 28th of September, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads dictated "the 25th of September to the 28th of September 2026"', async () => {
    const i = await parser.parse('Sydney to London, the 25th of September to the 28th of September 2026, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads dictated "September 25th to September 28th"', async () => {
    const i = await parser.parse('Sydney to London, September 25th to September 28th, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reads a return stated only as a bare ordinal', async () => {
    const i = await parser.parse('Sydney to London on the 25th of September returning the 28th, economy');
    expect([i.departureDate, i.returnDate]).toEqual(['2026-09-25', '2026-09-28']);
  });

  it('reports the assumption when no dates are given at all', async () => {
    const i = await parser.parse('Book me SYD to LHR economy');
    expect(i.assumptions.join(' ')).toContain('dates not stated');
  });
});

describe('stated budget', () => {
  // The point of capturing this is not the number, it is the ASSERTED AUTHORITY. The demo
  // beat is a traveller saying finance approved ten thousand and the gate using the org's
  // 1,300 cap regardless — which is only visible if the claim renders next to the cap.
  it('captures an approval the traveller asserts', async () => {
    const i = await parser.parse(
      'Book me a Sydney London business class flight 25th September to 28th September, finance approved 10,000 AUD for this trip',
    );
    expect(i.statedBudget).toBe('10000');
  });

  it('captures "authorised" and "signed off" too', async () => {
    expect((await parser.parse('SYD to LHR, my manager authorised 4,500 AUD')).statedBudget).toBe('4500');
    expect((await parser.parse('SYD to LHR, finance signed off on 2000')).statedBudget).toBe('2000');
  });

  it('still captures the plain limit forms', async () => {
    expect((await parser.parse('Book me SYD to LHR, under $1,200')).statedBudget).toBe('1200');
    expect((await parser.parse('Book me SYD to LHR, budget of 1500')).statedBudget).toBe('1500');
  });

  it('is absent when the traveller names no number', async () => {
    expect((await parser.parse('Book me SYD to LHR, 15-25 Sept, economy')).statedBudget).toBeUndefined();
  });
});

describe('route', () => {
  it('reads a plain "X to Y"', async () => {
    const i = await parser.parse('Book me SYD to LHR return, 15-25 Sept, economy');
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('does not match an airport code inside another word', async () => {
    // `sin` sits inside "bu(sin)ess" and used to route a London trip via Singapore.
    const i = await parser.parse("Book me business class SYD to LHR, 15-25 Sept - it's a long flight");
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('honours from/to markers over word order', async () => {
    const i = await parser.parse('Need to get to London from Sydney, 15-25 Sept');
    expect([i.origin, i.destination]).toEqual(['SYD', 'LHR']);
  });

  it('treats a single "to X" as the destination, not the origin', async () => {
    const i = await parser.parse('get me to london');
    expect(i.destination).toBe('LHR');
    expect(i.origin).toBe('SYD'); // the default, and reported as an assumption
    expect(i.assumptions.join(' ')).toContain('origin');
  });
});

describe('cabin', () => {
  it.each([
    ['fly me business class to London', 'business'],
    ['premium economy please', 'premium_economy'],
    ['first class SYD to LHR', 'first'],
    ['SYD to LHR economy', 'economy'],
  ])('reads %s', async (text, expected) => {
    expect((await parser.parse(text)).cabinClass).toBe(expected);
  });

  it('defaults to economy and says so', async () => {
    const i = await parser.parse('SYD to LHR, 15-25 Sept');
    expect(i.cabinClass).toBe('economy');
    expect(i.assumptions.join(' ')).toContain('cabin');
  });
});

describe('dates', () => {
  it('reads a day range and a month', async () => {
    const i = await parser.parse('SYD to LHR, 15-25 Sept');
    expect(i.departureDate).toBe('2026-09-15');
    expect(i.returnDate).toBe('2026-09-25');
  });

  it('accepts an en dash and the word "to"', async () => {
    expect((await parser.parse('SYD to LHR, 15–25 September')).departureDate).toBe('2026-09-15');
    expect((await parser.parse('SYD to LHR, 3 to 9 October')).returnDate).toBe('2026-10-09');
  });
});

describe("the traveller's stated budget", () => {
  it('is captured separately from the policy cap', async () => {
    // The traveller expresses a preference; the policy decides what is allowed. Keeping
    // them distinct is the point — the cap is never sourced from the instruction.
    const i = await parser.parse('Need to get to London from Sydney, 15-25 Sept, under $1,200');
    expect(i.statedBudget).toBe('1200');
  });

  it('is absent when unstated', async () => {
    expect((await parser.parse('SYD to LHR, 15-25 Sept')).statedBudget).toBeUndefined();
  });
});
