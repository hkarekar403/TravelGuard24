/**
 * Turning a plain-English instruction into a structured trip request.
 *
 * This is the seam where an LLM goes. `IntentParser` is the whole contract; the mock below
 * satisfies it deterministically so the interaction can be designed, demoed and recorded
 * without spending credits or depending on a network call mid-demo.
 *
 * WHY A MOCK IS THE RIGHT DEFAULT HERE, not just a cost saving:
 *  - A demo recording must be reproducible. A model that paraphrases differently between
 *    takes makes the screen unpredictable at the worst possible moment.
 *  - The parse is not what the project is about. The policy gate is. An LLM in this slot is
 *    a convenience for the user, not the claim being made.
 *
 * Swapping in a real model means implementing this interface and nothing else.
 */

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export type TripIntent = {
  origin: string;
  destination: string;
  departureDate: string; // YYYY-MM-DD
  returnDate: string;    // YYYY-MM-DD
  cabinClass: CabinClass;
  /**
   * A budget the traveller mentioned, if any. NOT the policy cap — the traveller's own
   * words. It is displayed so the two can be seen to be different things: the policy
   * decides what is allowed, the traveller only expresses a preference.
   */
  statedBudget?: string;
  /** What the agent could not determine and had to assume. Shown, never hidden. */
  assumptions: string[];
};

export interface IntentParser {
  parse(instruction: string): Promise<TripIntent>;
}

// ---------------------------------------------------------------------------

const AIRPORTS: Record<string, string> = {
  syd: 'SYD', sydney: 'SYD',
  lhr: 'LHR', london: 'LHR', heathrow: 'LHR',
  mel: 'MEL', melbourne: 'MEL',
  jfk: 'JFK', 'new york': 'JFK',
  sin: 'SIN', singapore: 'SIN',
  dxb: 'DXB', dubai: 'DXB',
  lax: 'LAX', 'los angeles': 'LAX',
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const CABIN_WORDS: Array<[RegExp, CabinClass]> = [
  [/\bfirst\s*class\b/i, 'first'],
  [/\bbusiness\b/i, 'business'],
  [/\bpremium\s*economy\b/i, 'premium_economy'],
  [/\beconomy\b/i, 'economy'],
];

const DEFAULTS = {
  origin: 'SYD',
  destination: 'LHR',
  departureDate: '2026-09-15',
  returnDate: '2026-09-25',
  cabinClass: 'economy' as CabinClass,
};

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Resolves the route.
 *
 * Prefers the explicit "from X" / "to Y" markers over word order, because English puts
 * them in either order — "to London from Sydney" means the same as "Sydney to London".
 * Order of appearance is only the fallback.
 *
 * Matching is word-boundaried. Substring matching silently found `sin` (Singapore) inside
 * "bu**sin**ess" and routed a London trip via Singapore.
 */
function findRoute(text: string): { origin: string | undefined; destination: string | undefined } {
  const lower = text.toLowerCase();

  const hits: Array<{ code: string; at: number; word: string }> = [];
  for (const [word, code] of Object.entries(AIRPORTS)) {
    const m = new RegExp(`\\b${word}\\b`).exec(lower);
    if (m && !hits.some((h) => h.code === code)) hits.push({ code, at: m.index, word });
  }
  hits.sort((a, b) => a.at - b.at);

  const marked = (marker: string): string | undefined =>
    hits.find((h) => new RegExp(`\\b${marker}\\s+${h.word}\\b`).test(lower))?.code;

  const from = marked('from');
  const to = marked('to');

  if (from && to && from !== to) return { origin: from, destination: to };
  // One marker is enough to place a single mention correctly: "get me to London" names a
  // destination, not an origin.
  if (to && !from) return { origin: hits.find((h) => h.code !== to)?.code, destination: to };
  if (from && !to) return { origin: from, destination: hits.find((h) => h.code !== from)?.code };

  return { origin: hits[0]?.code, destination: hits[1]?.code };
}

/** "15–25 Sept" / "15 to 25 September" / "Sept 15-25" → a date pair. */
function findDates(text: string, year: number): { departureDate: string | undefined; returnDate: string | undefined } {
  const month = Object.keys(MONTHS).find((m) => new RegExp(`\\b${m}`, 'i').test(text));
  if (!month) return { departureDate: undefined, returnDate: undefined };
  const mm = MONTHS[month];
  if (mm === undefined) return { departureDate: undefined, returnDate: undefined };

  const range = text.match(/(\d{1,2})\s*(?:–|-|—|to|until)\s*(\d{1,2})/);
  if (!range) return { departureDate: undefined, returnDate: undefined };
  const from = Number(range[1]);
  const to = Number(range[2]);
  if (!from || !to) return { departureDate: undefined, returnDate: undefined };

  return {
    departureDate: `${year}-${pad(mm)}-${pad(from)}`,
    returnDate: `${year}-${pad(mm)}-${pad(to)}`,
  };
}

/**
 * Deterministic stand-in for a model. Extracts route, dates, cabin and any budget the
 * traveller mentioned, and reports whatever it had to assume rather than silently
 * defaulting — an agent that hides its assumptions is not one you can supervise.
 */
export function createMockIntentParser(opts: { year?: number } = {}): IntentParser {
  const year = opts.year ?? 2026;

  return {
    async parse(instruction: string): Promise<TripIntent> {
      const assumptions: string[] = [];

      const { origin, destination } = findRoute(instruction);
      if (!origin) assumptions.push(`origin not stated — assumed ${DEFAULTS.origin}`);
      if (!destination) assumptions.push(`destination not stated — assumed ${DEFAULTS.destination}`);

      const { departureDate, returnDate } = findDates(instruction, year);
      if (!departureDate) assumptions.push(`dates not stated — assumed ${DEFAULTS.departureDate} to ${DEFAULTS.returnDate}`);

      const cabin = CABIN_WORDS.find(([re]) => re.test(instruction))?.[1];
      if (!cabin) assumptions.push('cabin not stated — assumed economy');

      // The traveller's own number, kept separate from the policy cap on purpose.
      const budget = instruction.match(/(?:under|below|max(?:imum)?|budget(?: of)?|less than)\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
      const statedBudget = budget?.[1]?.replace(/,/g, '');

      return {
        origin: origin ?? DEFAULTS.origin,
        destination: destination ?? DEFAULTS.destination,
        departureDate: departureDate ?? DEFAULTS.departureDate,
        returnDate: returnDate ?? DEFAULTS.returnDate,
        cabinClass: cabin ?? DEFAULTS.cabinClass,
        ...(statedBudget ? { statedBudget } : {}),
        assumptions,
      };
    },
  };
}
