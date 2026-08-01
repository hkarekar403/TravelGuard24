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
