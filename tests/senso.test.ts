/**
 * Senso as the policy source.
 *
 * The property under test is not "does retrieval work" — it is "can retrieval ever make
 * the gate more permissive, or stop the demo". Both answers must be no, on every path.
 */

import { describe, expect, it } from 'vitest';
import {
  extractJsonObject,
  guardTightenOnly,
  readAnswer,
  readCitations,
  resolvePolicy,
  validateRules,
  type RetrievedRules,
  type SensoClient,
} from '../src/policy/senso.js';
import type { Policy } from '../src/policy/types.js';

const LOCAL: Policy = {
  version: 'v1',
  org: 'Acme Corp',
  currency: 'AUD',
  budgetCapMinor: 130000,
  allowedCabinClasses: ['economy'],
  minAdvanceDays: 14,
  vendorAllowlist: ['ZZ', 'IB', 'BA', 'AA'],
};

const BASELINE_RULES: RetrievedRules = {
  currency: 'AUD',
  budgetCapMinor: 130000,
  allowedCabinClasses: ['economy'],
  minAdvanceDays: 14,
  vendorAllowlist: ['ZZ', 'IB', 'BA', 'AA'],
};

/** A client that returns whatever payload the test hands it. */
const clientReturning = (payload: unknown): SensoClient => ({
  search: async () => payload as never,
});

const clientThatThrows = (message: string): SensoClient => ({
  search: async () => {
    throw new Error(message);
  },
});

const answerWith = (rules: unknown, extra: Record<string, unknown> = {}) => ({
  answer: JSON.stringify(rules),
  ...extra,
});

// ---------------------------------------------------------------------------

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads an object wrapped in prose', () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('reads an object inside a fenced code block', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('does not truncate at a nested closing brace', () => {
    // A lazy regex match stops at the first `}` and loses the rest of the object.
    const text = 'answer: {"outer":{"inner":1},"list":[1,2,3]}';
    expect(extractJsonObject(text)).toEqual({ outer: { inner: 1 }, list: [1, 2, 3] });
  });

  it('is not confused by braces inside strings', () => {
    expect(extractJsonObject('{"note":"a } brace","n":2}')).toEqual({ note: 'a } brace', n: 2 });
  });

  it('returns null when there is no object', () => {
    expect(extractJsonObject('no json here')).toBeNull();
  });

  it('returns null on malformed json rather than throwing', () => {
    expect(extractJsonObject('{"a":}')).toBeNull();
  });
});

describe('readAnswer / readCitations', () => {
  it('finds the answer under any of the documented-ish field names', () => {
    expect(readAnswer({ text: 'hello' })).toBe('hello');
    expect(readAnswer({ result: 'hello' })).toBe('hello');
    expect(readAnswer({ response: 'hello' })).toBe('hello');
  });

  it('treats an empty or non-string answer as absent', () => {
    expect(readAnswer({ answer: '   ' })).toBeNull();
    expect(readAnswer({ answer: 42 })).toBeNull();
    expect(readAnswer({})).toBeNull();
  });

  it('collects citation labels from objects and strings, deduplicated', () => {
    const cites = readCitations({
      sources: [{ title: 'ACME-TRV-001' }, 'ACME-TRV-001', { url: 'https://x/y' }],
    });
    expect(cites).toEqual(['ACME-TRV-001', 'https://x/y']);
  });

  it('survives a citations payload that is not an array', () => {
    expect(readCitations({ sources: 'nope' })).toEqual([]);
  });
});

describe('validateRules', () => {
  it('accepts a well-formed object', () => {
    const r = validateRules(BASELINE_RULES);
    expect(r.ok).toBe(true);
  });

  it('rejects a partial object rather than merging it over the baseline', () => {
    const r = validateRules({ budgetCapMinor: 120000 });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-integer or negative cap', () => {
    expect(validateRules({ ...BASELINE_RULES, budgetCapMinor: 1300.5 }).ok).toBe(false);
    expect(validateRules({ ...BASELINE_RULES, budgetCapMinor: -1 }).ok).toBe(false);
    expect(validateRules({ ...BASELINE_RULES, budgetCapMinor: 0 }).ok).toBe(false);
  });

  it('rejects an empty allowlist — that would block every booking silently', () => {
    expect(validateRules({ ...BASELINE_RULES, vendorAllowlist: [] }).ok).toBe(false);
    expect(validateRules({ ...BASELINE_RULES, allowedCabinClasses: [] }).ok).toBe(false);
  });

  it('rejects a cap sent as a string', () => {
    expect(validateRules({ ...BASELINE_RULES, budgetCapMinor: '130000' }).ok).toBe(false);
  });

  it('rejects an array or null', () => {
    expect(validateRules([]).ok).toBe(false);
    expect(validateRules(null).ok).toBe(false);
  });
});

describe('guardTightenOnly — a retrieval may tighten, never widen', () => {
  it('accepts an identical policy and reports nothing tightened', () => {
    const r = guardTightenOnly(LOCAL, BASELINE_RULES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tightened).toEqual([]);
  });

  it('REJECTS a higher budget cap', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, budgetCapMinor: 500000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]).toContain('exceeds baseline');
  });

  it('REJECTS an added cabin class', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, allowedCabinClasses: ['economy', 'business'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]).toContain('business');
  });

  it('REJECTS an added carrier', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, vendorAllowlist: [...BASELINE_RULES.vendorAllowlist, 'XX'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]).toContain('XX');
  });

  it('REJECTS a shorter advance-purchase window', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, minAdvanceDays: 2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]).toContain('below baseline');
  });

  it('REJECTS a different currency, which cannot be shown to be a tightening', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, currency: 'USD' });
    expect(r.ok).toBe(false);
  });

  it('reports every violation at once, not just the first', () => {
    const r = guardTightenOnly(LOCAL, {
      currency: 'USD',
      budgetCapMinor: 999999,
      allowedCabinClasses: ['first'],
      minAdvanceDays: 0,
      vendorAllowlist: ['QF'],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.length).toBe(5);
  });

  it('ACCEPTS a lower cap and records the tightening', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, budgetCapMinor: 120000 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.budgetCapMinor).toBe(120000);
      expect(r.tightened).toEqual(['budgetCapMinor 130000 -> 120000']);
    }
  });

  it('ACCEPTS a shorter carrier list', () => {
    const r = guardTightenOnly(LOCAL, { ...BASELINE_RULES, vendorAllowlist: ['ZZ', 'BA'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.vendorAllowlist).toEqual(['ZZ', 'BA']);
  });

  it('never takes org or version from the retrieval', () => {
    const r = guardTightenOnly(LOCAL, BASELINE_RULES);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.policy.org).toBe('Acme Corp');
      // Suffixed so an audit entry shows the policy was source-grounded.
      expect(r.policy.version).toBe('v1+senso');
    }
  });
});

describe('resolvePolicy — every path yields a usable policy', () => {
  const now = () => new Date('2026-08-02T00:00:00Z');

  it('falls back when Senso is not configured', async () => {
    const r = await resolvePolicy({ local: LOCAL, now });
    expect(r.policy).toEqual(LOCAL);
    expect(r.provenance).toMatchObject({ source: 'local', reason: 'not_configured' });
  });

  it('falls back when the request throws, without propagating', async () => {
    const r = await resolvePolicy({ local: LOCAL, client: clientThatThrows('ECONNRESET'), now });
    expect(r.policy).toEqual(LOCAL);
    expect(r.provenance.reason).toBe('request_failed');
    expect(r.provenance.detail).toContain('ECONNRESET');
  });

  it('falls back when the response carries no answer', async () => {
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning({}), now });
    expect(r.provenance.reason).toBe('no_answer');
    expect(r.policy).toEqual(LOCAL);
  });

  it('reports an empty knowledge base as no_results, not as a parse failure', async () => {
    // The live shape when nothing is ingested yet: prose that parses as an answer but
    // yields no JSON. Calling that `unparseable` sends you to the wrong bug.
    const empty = { answer: 'No results found for your query.', results: [], total_results: 0 };
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning(empty), now });
    expect(r.provenance.reason).toBe('no_results');
    expect(r.policy).toEqual(LOCAL);
  });

  it('falls back when the answer contains no JSON', async () => {
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning({ answer: 'I am not sure.' }), now });
    expect(r.provenance.reason).toBe('unparseable');
    expect(r.policy).toEqual(LOCAL);
  });

  it('falls back when the JSON fails the schema, listing the problems', async () => {
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning(answerWith({ budgetCapMinor: 1 })), now });
    expect(r.provenance.reason).toBe('schema_invalid');
    expect(r.provenance.rejected?.length).toBeGreaterThan(0);
    expect(r.policy).toEqual(LOCAL);
  });

  it('falls back — and does NOT apply — a policy that would widen spending authority', async () => {
    const widened = { ...BASELINE_RULES, budgetCapMinor: 900000, allowedCabinClasses: ['economy', 'business'] };
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning(answerWith(widened)), now });
    expect(r.provenance.reason).toBe('would_widen');
    expect(r.policy.budgetCapMinor).toBe(130000);
    expect(r.policy.allowedCabinClasses).toEqual(['economy']);
  });

  it('applies a retrieved policy that matches the source document, with citations', async () => {
    const r = await resolvePolicy({
      local: LOCAL,
      client: clientReturning(answerWith(BASELINE_RULES, { sources: [{ title: 'ACME-TRV-001 v1.4' }] })),
      now,
    });
    expect(r.provenance).toMatchObject({ source: 'senso', reason: 'retrieved' });
    expect(r.provenance.citations).toEqual(['ACME-TRV-001 v1.4']);
    expect(r.policy.version).toBe('v1+senso');
  });

  it('applies a tightening and records it', async () => {
    const tighter = { ...BASELINE_RULES, budgetCapMinor: 100000 };
    const r = await resolvePolicy({ local: LOCAL, client: clientReturning(answerWith(tighter)), now });
    expect(r.provenance.source).toBe('senso');
    expect(r.policy.budgetCapMinor).toBe(100000);
    expect(r.provenance.tightened).toEqual(['budgetCapMinor 130000 -> 100000']);
  });

  it('stamps the attempt time on every outcome', async () => {
    const r = await resolvePolicy({ local: LOCAL, now });
    expect(r.provenance.retrievedAt).toBe('2026-08-02T00:00:00.000Z');
  });
});
