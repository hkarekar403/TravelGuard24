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

/**
 * Date extraction.
 *
 * TWO FAILURES THIS REPLACES, both found on camera (2026-08-02):
 *
 *  - The old range regex was a bare `(\d{1,2})...(\d{1,2})`, so it read **26 out of 2026**:
 *    "25 September 2026 to 28th September 2026" booked 26–28 Sep. A wrong date that still
 *    looks plausible is the worst kind, because nothing downstream can detect it.
 *  - It also required the two numbers to be adjacent to the separator, so
 *    "25 September to 28 September" matched nothing and fell back to the demo defaults
 *    **silently under an assumption message nobody reads as an error**.
 *
 * The rule now: a number only counts as a day if it is anchored to a month name. That is
 * what keeps "$1,200", "1500 AUD" and "10K" from being read as dates, and it is why the
 * two forms below are matched explicitly rather than by scanning for loose digits.
 */

/** A day, optionally ordinal, that is not a fragment of a longer number ("2026", "1500"). */
const DAY = String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th)?(?!\d)`;
const MONTH_NAME = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;
const RANGE_SEP = String.raw`\s*(?:[–—-]|to|until|through)\s*`;

/** "september" / "sept" / "sep" → 9. */
function monthOf(word: string): number | undefined {
  const key = word.toLowerCase();
  return MONTHS[key.slice(0, 4)] ?? MONTHS[key.slice(0, 3)];
}

function findDates(text: string, year: number): { departureDate: string | undefined; returnDate: string | undefined } {
  const none = { departureDate: undefined, returnDate: undefined };

  const format = (day: number, month: number, y: number): string | undefined =>
    day >= 1 && day <= 31 ? `${y}-${pad(month)}-${pad(day)}` : undefined;

  const build = (
    dep: { day: number; month: number },
    ret: { day: number; month: number },
  ): { departureDate: string | undefined; returnDate: string | undefined } => {
    // A return in an earlier month is the following year — "28 Dec to 3 Jan".
    const retYear = ret.month < dep.month ? year + 1 : year;
    const departureDate = format(dep.day, dep.month, year);
    const returnDate = format(ret.day, ret.month, retYear);
    return departureDate && returnDate ? { departureDate, returnDate } : none;
  };

  // 1. A range that names its month once: "15-25 Sept", "25th to 28th September".
  const rangeThenMonth = new RegExp(`${DAY}${RANGE_SEP}${DAY}\\s+${MONTH_NAME}`, 'i').exec(text);
  if (rangeThenMonth) {
    const mm = monthOf(rangeThenMonth[3]!);
    if (mm) return build({ day: Number(rangeThenMonth[1]), month: mm }, { day: Number(rangeThenMonth[2]), month: mm });
  }

  // 2. Month first: "Sept 15-25".
  const monthThenRange = new RegExp(`${MONTH_NAME}\\s+${DAY}${RANGE_SEP}${DAY}`, 'i').exec(text);
  if (monthThenRange) {
    const mm = monthOf(monthThenRange[1]!);
    if (mm) return build({ day: Number(monthThenRange[2]), month: mm }, { day: Number(monthThenRange[3]), month: mm });
  }

  // 3. Two independent day+month mentions, in either order and with years present:
  //    "25 September 2026 to 28th September 2026", "25 Sept to 3 Oct".
  const pair = new RegExp(`(?:${DAY}\\s+${MONTH_NAME})|(?:${MONTH_NAME}\\s+${DAY})`, 'gi');
  const found: Array<{ day: number; month: number }> = [];
  for (const m of text.matchAll(pair)) {
    const day = m[1] ?? m[4];
    const monthWord = m[2] ?? m[3];
    if (!day || !monthWord) continue;
    const mm = monthOf(monthWord);
    if (mm) found.push({ day: Number(day), month: mm });
    if (found.length === 2) break;
  }
  if (found.length === 2) return build(found[0]!, found[1]!);

  return none;
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
