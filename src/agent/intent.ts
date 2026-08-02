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
};

export type MissingField = 'origin' | 'destination' | 'dates' | 'cabin';

/**
 * The parse either yielded a complete instruction or it did not. There is no third state.
 *
 * WHY THERE ARE NO DEFAULTS ANY MORE — this replaced a version that filled the gaps and
 * disclosed the guesses in an "assumptions" line. Dictation made the cost of that obvious:
 * a message containing only dates was completed into a Sydney→London economy trip, priced,
 * and offered for passkey approval. The traveller was one tap from paying for a route they
 * had never named. A disclosure the agent prints to itself is not consent.
 *
 * So a `TripIntent` can no longer be constructed with a field nobody supplied — the type is
 * what enforces it, not a convention. Anything missing means the request is returned to the
 * human to state again in full.
 */
export type ParseResult =
  | { complete: true; intent: TripIntent }
  | { complete: false; missing: MissingField[]; heard: Partial<TripIntent> };

export interface IntentParser {
  parse(instruction: string): Promise<ParseResult>;
}

const CABINS: readonly CabinClass[] = ['economy', 'premium_economy', 'business', 'first'];
const isCabin = (v: string): v is CabinClass => (CABINS as readonly string[]).includes(v);

/**
 * Resolves an unstated cabin from the policy — but only when the policy leaves exactly one
 * possibility.
 *
 * This is DEDUCTION, not a default. If the policy permits economy only, there is precisely
 * one cabin the agent could ever book, so requiring the traveller to name it is asking them
 * to recite the policy back. If the policy permits two or more, the choice is genuinely
 * ambiguous and is asked for, exactly like a missing route.
 *
 * The parser is deliberately left honest — it still reports `cabin` as missing, because it
 * has no business knowing the policy. The resolution happens here, where the policy is
 * known, and is surfaced to the traveller rather than applied silently.
 */
export function completeWithPolicyCabin(
  result: ParseResult,
  allowedCabins: readonly string[],
): { result: ParseResult; derivedCabin: CabinClass | null } {
  if (result.complete) return { result, derivedCabin: null };
  if (!result.missing.includes('cabin')) return { result, derivedCabin: null };

  const only = allowedCabins.length === 1 ? allowedCabins[0] : undefined;
  if (!only || !isCabin(only)) return { result, derivedCabin: null };

  const missing = result.missing.filter((m) => m !== 'cabin');
  const heard = { ...result.heard, cabinClass: only };

  // Everything else was present, so the request is now actionable.
  if (missing.length === 0) {
    return {
      result: {
        complete: true,
        intent: {
          origin: heard.origin!,
          destination: heard.destination!,
          departureDate: heard.departureDate!,
          returnDate: heard.returnDate!,
          cabinClass: only,
          ...(heard.statedBudget ? { statedBudget: heard.statedBudget } : {}),
        },
      },
      derivedCabin: only,
    };
  }

  // Still incomplete for other reasons — but do not ask for the cabin, since the policy
  // has already determined it.
  return { result: { complete: false, missing, heard }, derivedCabin: only };
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
  [/\bpremium\s*econom(?:y|ic)\b/i, 'premium_economy'],
  // "economic" is what dictation writes when you say "economy" — observed on a live run.
  [/\beconom(?:y|ic)\b/i, 'economy'],
];

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Spoken ordinals → digits: "third" → "3th", "twenty fifth" → "25th".
 *
 * Dictation writes these as words — *"returning back on third October"* — where a keyboard
 * writes "3rd". Without this the date is simply not found.
 *
 * APPLIED ONLY TO DATE PARSING, never to the whole instruction: "first class" would become
 * "1th class" and the cabin would stop being recognised. The suffix is always "th" because
 * the day pattern accepts any of st/nd/rd/th and nothing renders this text.
 */
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8,
  ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14,
  fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19,
  twentieth: 20, thirtieth: 30,
};

const ONES = 'first|second|third|fourth|fifth|sixth|seventh|eighth|ninth';

export function normaliseSpokenOrdinals(text: string): string {
  return text
    // Compound first, or "twenty" would be consumed alone: "twenty fifth", "thirty-first".
    .replace(new RegExp(String.raw`\b(twenty|thirty)[\s-](${ONES})\b`, 'gi'), (_m, tens: string, ones: string) => {
      const base = tens.toLowerCase() === 'twenty' ? 20 : 30;
      return `${base + (ORDINAL_WORDS[ones.toLowerCase()] ?? 0)}th`;
    })
    .replace(new RegExp(String.raw`\b(${Object.keys(ORDINAL_WORDS).join('|')})\b`, 'gi'), (m) => {
      const n = ORDINAL_WORDS[m.toLowerCase()];
      return n === undefined ? m : `${n}th`;
    });
}

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
/** Same, but the ordinal suffix is required — safe to match on its own. */
const ORDINAL_DAY = String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th)(?!\d)`;
const MONTH_NAME = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*`;
const RANGE_SEP = String.raw`\s*(?:[–—-]|to|until|through)\s*`;
/**
 * The filler between a day and its month. Dictation says "the 25th **of** September" where
 * typing says "25 September" — without this the day and month stop being adjacent and the
 * whole date silently falls back to the demo default.
 */
const OF = String.raw`\s+(?:of\s+)?(?:the\s+)?`;

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

  // 1. A range that names its month once: "15-25 Sept", "25th to 28th of September".
  const rangeThenMonth = new RegExp(`${DAY}${RANGE_SEP}${DAY}${OF}${MONTH_NAME}`, 'i').exec(text);
  if (rangeThenMonth) {
    const mm = monthOf(rangeThenMonth[3]!);
    if (mm) return build({ day: Number(rangeThenMonth[1]), month: mm }, { day: Number(rangeThenMonth[2]), month: mm });
  }

  // 2. Month first: "Sept 15-25".
  const monthThenRange = new RegExp(`${MONTH_NAME}${OF}${DAY}${RANGE_SEP}${DAY}`, 'i').exec(text);
  if (monthThenRange) {
    const mm = monthOf(monthThenRange[1]!);
    if (mm) return build({ day: Number(monthThenRange[2]), month: mm }, { day: Number(monthThenRange[3]), month: mm });
  }

  // 3. Two independent day+month mentions, in either order and with years present:
  //    "25 September 2026 to 28th September 2026", "the 25th of September to the 28th of
  //    September", "25 Sept to 3 Oct".
  const pair = new RegExp(`(?:${DAY}${OF}${MONTH_NAME})|(?:${MONTH_NAME}${OF}${DAY})`, 'gi');
  const found: Array<{ day: number; month: number; at: number }> = [];
  for (const m of text.matchAll(pair)) {
    const day = m[1] ?? m[4];
    const monthWord = m[2] ?? m[3];
    if (!day || !monthWord) continue;
    const mm = monthOf(monthWord);
    if (mm) found.push({ day: Number(day), month: mm, at: m.index + m[0].length });
    if (found.length === 2) break;
  }
  if (found.length === 2) return build(found[0]!, found[1]!);

  // 4. One day+month, then a bare ordinal day — "on the 25th of September, returning the
  //    28th". Common in speech, and the ordinal suffix is what makes a lone number safe to
  //    read as a day at all.
  if (found.length === 1) {
    const first = found[0]!;
    const rest = text.slice(first.at);
    const trailing = new RegExp(ORDINAL_DAY).exec(rest);
    if (trailing) return build(first, { day: Number(trailing[1]), month: first.month });
  }

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
    async parse(instruction: string): Promise<ParseResult> {
      const { origin, destination } = findRoute(instruction);

      // Ordinals are spelled out only for the date pass — see `normaliseSpokenOrdinals`.
      const { departureDate, returnDate } = findDates(normaliseSpokenOrdinals(instruction), year);

      const cabin = CABIN_WORDS.find(([re]) => re.test(instruction))?.[1];

      // The traveller's own number, kept separate from the policy cap on purpose.
      //
      // "approved" and "authorised" matter as much as "under": the interesting case is not
      // a traveller setting themselves a limit, it is one asserting an AUTHORITY —
      // "finance approved 10,000" — and the gate declining to honour it. That beat is only
      // visible if the number is captured, so the claim and the cap can sit side by side.
      // The currency can arrive as a prefix, and dictation picks the form: "AU$10,000",
      // "A$1,200", "$1,200", "10,000 AUD". Allowing only a bare `$` meant "approved
      // AU$10,000" captured nothing at all — the letters before the symbol broke the match,
      // and the traveller's claim silently failed to render beside the cap.
      // Deliberately liberal about verb endings. Three recorded runs produced three
      // different transcriptions of the same spoken sentence — "approved", "approve", and
      // the currency as "AU$10,000" rather than "10,000 AUD". Matching one exact form means
      // the claim silently fails to render, which is worse than matching too eagerly: the
      // number is only ever DISPLAYED beside the cap, never used in a decision.
      const budget = instruction.match(
        /(?:under|below|max(?:imum)?|budget(?: of)?|less than|approv(?:e|es|ed)|authoris(?:e|es|ed)|authoriz(?:e|es|ed)|sign(?:s|ed)? off(?: on)?)\s*(?:for\s*)?(?:[a-z]{0,3}\s*)?[$€£]?\s*([\d,]+(?:\.\d{2})?)/i,
      );
      const statedBudget = budget?.[1]?.replace(/,/g, '');

      // Reported in the order a person would say them, so the message back reads naturally.
      const missing: MissingField[] = [];
      if (!origin) missing.push('origin');
      if (!destination) missing.push('destination');
      if (!departureDate || !returnDate) missing.push('dates');
      if (!cabin) missing.push('cabin');

      if (missing.length > 0) {
        // What WAS understood is returned so the screen can show the agent heard something
        // rather than nothing — but it is a `Partial`, and nothing downstream can mistake
        // it for an instruction.
        return {
          complete: false,
          missing,
          heard: {
            ...(origin ? { origin } : {}),
            ...(destination ? { destination } : {}),
            ...(departureDate ? { departureDate } : {}),
            ...(returnDate ? { returnDate } : {}),
            ...(cabin ? { cabinClass: cabin } : {}),
            ...(statedBudget ? { statedBudget } : {}),
          },
        };
      }

      return {
        complete: true,
        intent: {
          origin: origin!,
          destination: destination!,
          departureDate: departureDate!,
          returnDate: returnDate!,
          cabinClass: cabin!,
          ...(statedBudget ? { statedBudget } : {}),
        },
      };
    },
  };
}
