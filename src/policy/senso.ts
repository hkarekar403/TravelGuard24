/**
 * Senso as the policy's source of record.
 *
 * `policy.json` re-states rules that actually live in a signed document
 * (`docs/acme-corp-travel-policy.md`). That re-statement is unevidenced: the audit entry
 * cites a JSON literal a developer typed, not the clause a CFO approved. Senso ingests the
 * document and answers questions against it with citations, so the rules the gate enforces
 * can be traced back to the source that authorises them.
 *
 * TWO PROPERTIES MAKE THIS SAFE TO PUT IN FRONT OF A SPENDING DECISION:
 *
 *   1. It can only ever TIGHTEN. A retrieved policy that is more permissive than the
 *      committed baseline — a higher cap, an extra cabin, a longer carrier list, a shorter
 *      advance window — is REJECTED, not applied. So the worst case of a bad retrieval, a
 *      hallucinated number or a compromised knowledge base is that we fall back to
 *      `policy.json`; the second-worst is that we are stricter than intended. Spending
 *      authority cannot be widened by anything that comes back over the network.
 *
 *   2. It cannot fail the demo. Every failure path — no key, timeout, non-2xx, unparseable
 *      answer, schema violation, guard violation — returns the local policy and records why.
 *      Senso is never on the critical path; it is a provenance layer over a decision that
 *      is already fully determined locally.
 *
 * The gate itself is untouched and still pure. This module only decides which `Policy`
 * value it is handed.
 */

import { request } from '../http.js';
import type { Policy } from './types.js';

const SENSO_BASE_URL = 'https://apiv2.senso.ai/api/v1';

/**
 * Short on purpose. This runs at server startup, and a slow knowledge base must not delay
 * the demo — falling back to the committed policy is always an acceptable outcome.
 */
const DEFAULT_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Provenance — recorded whichever way the policy resolved.
// ---------------------------------------------------------------------------

export type PolicySource = 'senso' | 'local';

/**
 * Why the policy resolved the way it did. `local` is a normal outcome, not an error, so
 * every reason is a plain fact rather than a failure code.
 */
export type ProvenanceReason =
  | 'not_configured'
  | 'retrieved'
  | 'request_failed'
  | 'no_answer'
  | 'unparseable'
  | 'schema_invalid'
  | 'would_widen';

export type PolicyProvenance = {
  source: PolicySource;
  reason: ProvenanceReason;
  /** ISO timestamp of the retrieval attempt. */
  retrievedAt: string;
  /** Document titles or URLs Senso grounded the answer in. Empty when local. */
  citations: string[];
  /**
   * Fields the retrieved policy tightened relative to the baseline, e.g.
   * "budgetCapMinor 130000 -> 120000". Empty when nothing changed.
   */
  tightened: string[];
  /** Present when `reason` is `would_widen` or `schema_invalid` — what was wrong. */
  rejected?: string[];
  /** Free-text detail for the operator. Never shown to a traveller. */
  detail?: string;
};

export type ResolvedPolicy = {
  policy: Policy;
  provenance: PolicyProvenance;
};

// ---------------------------------------------------------------------------
// The question we ask the knowledge base.
// ---------------------------------------------------------------------------

/**
 * Asks for the machine-readable block that section 5 of the policy document already
 * contains, rather than asking the model to infer values from prose. Retrieval of a stated
 * fact is a much narrower operation than interpretation, and the tightening guard exists
 * precisely because that narrowness cannot be assumed.
 */
const POLICY_QUERY =
  'What is the current corporate air travel policy? Return only the machine-readable JSON ' +
  'summary object with exactly these fields: currency, budgetCapMinor, allowedCabinClasses, ' +
  'minAdvanceDays, vendorAllowlist. Return raw JSON with no commentary.';

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type SensoClient = {
  search: (query: string) => Promise<SensoSearchResponse>;
};

/**
 * Senso's search response shape is not pinned in their public docs, so every field here is
 * optional and read defensively. `text` is normalised by `readAnswer` below.
 */
export type SensoSearchResponse = {
  answer?: unknown;
  text?: unknown;
  result?: unknown;
  content?: unknown;
  response?: unknown;
  sources?: unknown;
  citations?: unknown;
  results?: unknown;
};

export function createSensoClient(apiKey: string, baseUrl = SENSO_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS): SensoClient {
  return {
    search: (query) =>
      request<SensoSearchResponse>({
        method: 'POST',
        url: `${baseUrl}/org/search`,
        headers: { 'X-API-Key': apiKey },
        body: { query },
        timeoutMs,
        vendor: 'senso',
      }),
  };
}

/** Pulls the answer text out of whichever field the API used. */
export function readAnswer(res: SensoSearchResponse): string | null {
  for (const value of [res.answer, res.text, res.result, res.content, res.response]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** Best-effort citation extraction. Titles or URLs, whichever the payload carries. */
export function readCitations(res: SensoSearchResponse): string[] {
  const out: string[] = [];
  for (const bucket of [res.sources, res.citations, res.results]) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (typeof entry === 'string') {
        out.push(entry);
      } else if (entry && typeof entry === 'object') {
        const rec = entry as Record<string, unknown>;
        const label = rec['title'] ?? rec['name'] ?? rec['url'] ?? rec['source'] ?? rec['document_id'];
        if (typeof label === 'string' && label.trim()) out.push(label);
      }
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the first JSON object from an answer that may be wrapped in prose or a fenced
 * code block. Brace-counting rather than a regex, because the payload contains nested
 * arrays and a lazy match truncates them.
 */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The four rule fields plus currency. Everything else on `Policy` stays local. */
export type RetrievedRules = {
  currency: string;
  budgetCapMinor: number;
  allowedCabinClasses: string[];
  minAdvanceDays: number;
  vendorAllowlist: string[];
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.trim() !== '');

/**
 * Strict, and deliberately all-or-nothing: a partial answer is rejected rather than merged
 * over the baseline. Merging would mean a retrieval that silently dropped a field still
 * changed the policy, which is the kind of half-applied state that is impossible to reason
 * about after the fact.
 */
export function validateRules(value: unknown): { ok: true; rules: RetrievedRules } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['not a JSON object'] };
  }
  const v = value as Record<string, unknown>;

  if (typeof v['currency'] !== 'string' || !v['currency'].trim()) problems.push('currency must be a non-empty string');
  if (typeof v['budgetCapMinor'] !== 'number' || !Number.isInteger(v['budgetCapMinor']) || v['budgetCapMinor'] <= 0) {
    problems.push('budgetCapMinor must be a positive integer in minor units');
  }
  if (!isStringArray(v['allowedCabinClasses'])) problems.push('allowedCabinClasses must be a non-empty string array');
  if (typeof v['minAdvanceDays'] !== 'number' || !Number.isInteger(v['minAdvanceDays']) || v['minAdvanceDays'] < 0) {
    problems.push('minAdvanceDays must be a non-negative integer');
  }
  if (!isStringArray(v['vendorAllowlist'])) problems.push('vendorAllowlist must be a non-empty string array');

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    rules: {
      currency: v['currency'] as string,
      budgetCapMinor: v['budgetCapMinor'] as number,
      allowedCabinClasses: v['allowedCabinClasses'] as string[],
      minAdvanceDays: v['minAdvanceDays'] as number,
      vendorAllowlist: v['vendorAllowlist'] as string[],
    },
  };
}

// ---------------------------------------------------------------------------
// The tightening guard — the reason this is safe.
// ---------------------------------------------------------------------------

export type GuardResult =
  | { ok: true; policy: Policy; tightened: string[] }
  | { ok: false; violations: string[] };

/**
 * A retrieved policy may only be equal to or STRICTER than the committed baseline.
 *
 * "Stricter" per field:
 *   budgetCapMinor       lower or equal      (less money)
 *   allowedCabinClasses  subset              (fewer cabins)
 *   minAdvanceDays       higher or equal     (longer lead time)
 *   vendorAllowlist      subset              (fewer carriers)
 *   currency             identical           (a different currency is not comparable,
 *                                             so it cannot be shown to be a tightening)
 *
 * `org` and `version` are identity, not rules, and are never taken from the retrieval.
 * The resulting version is suffixed so an audit entry shows the policy was source-grounded.
 */
export function guardTightenOnly(local: Policy, rules: RetrievedRules): GuardResult {
  const violations: string[] = [];
  const tightened: string[] = [];

  if (rules.currency !== local.currency) {
    violations.push(`currency ${rules.currency} != baseline ${local.currency}`);
  }

  if (rules.budgetCapMinor > local.budgetCapMinor) {
    violations.push(`budgetCapMinor ${rules.budgetCapMinor} exceeds baseline ${local.budgetCapMinor}`);
  } else if (rules.budgetCapMinor < local.budgetCapMinor) {
    tightened.push(`budgetCapMinor ${local.budgetCapMinor} -> ${rules.budgetCapMinor}`);
  }

  const extraCabins = rules.allowedCabinClasses.filter((c) => !local.allowedCabinClasses.includes(c));
  if (extraCabins.length > 0) {
    violations.push(`allowedCabinClasses adds ${extraCabins.join(', ')}`);
  } else if (rules.allowedCabinClasses.length < local.allowedCabinClasses.length) {
    tightened.push(`allowedCabinClasses ${local.allowedCabinClasses.length} -> ${rules.allowedCabinClasses.length}`);
  }

  if (rules.minAdvanceDays < local.minAdvanceDays) {
    violations.push(`minAdvanceDays ${rules.minAdvanceDays} below baseline ${local.minAdvanceDays}`);
  } else if (rules.minAdvanceDays > local.minAdvanceDays) {
    tightened.push(`minAdvanceDays ${local.minAdvanceDays} -> ${rules.minAdvanceDays}`);
  }

  const extraVendors = rules.vendorAllowlist.filter((c) => !local.vendorAllowlist.includes(c));
  if (extraVendors.length > 0) {
    violations.push(`vendorAllowlist adds ${extraVendors.join(', ')}`);
  } else if (rules.vendorAllowlist.length < local.vendorAllowlist.length) {
    tightened.push(`vendorAllowlist ${local.vendorAllowlist.length} -> ${rules.vendorAllowlist.length}`);
  }

  if (violations.length > 0) return { ok: false, violations };

  return {
    ok: true,
    tightened,
    policy: {
      ...local,
      version: `${local.version}+senso`,
      currency: rules.currency,
      budgetCapMinor: rules.budgetCapMinor,
      allowedCabinClasses: rules.allowedCabinClasses,
      minAdvanceDays: rules.minAdvanceDays,
      vendorAllowlist: rules.vendorAllowlist,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolveOptions = {
  /** The committed baseline. Always the fallback, and always the ceiling. */
  local: Policy;
  /** Absent means Senso is not configured, which is a normal outcome. */
  client?: SensoClient | undefined;
  now?: () => Date;
};

/**
 * Never throws and never rejects. Every path returns a usable policy — that is the whole
 * contract, and it is what lets this sit at startup in front of a live demo.
 */
export async function resolvePolicy(opts: ResolveOptions): Promise<ResolvedPolicy> {
  const now = opts.now ?? (() => new Date());
  const retrievedAt = now().toISOString();
  const fallback = (reason: ProvenanceReason, detail?: string, rejected?: string[]): ResolvedPolicy => ({
    policy: opts.local,
    provenance: {
      source: 'local',
      reason,
      retrievedAt,
      citations: [],
      tightened: [],
      ...(rejected ? { rejected } : {}),
      ...(detail ? { detail } : {}),
    },
  });

  if (!opts.client) return fallback('not_configured');

  let res: SensoSearchResponse;
  try {
    res = await opts.client.search(POLICY_QUERY);
  } catch (err) {
    return fallback('request_failed', err instanceof Error ? err.message : String(err));
  }

  const answer = readAnswer(res);
  if (!answer) return fallback('no_answer');

  const citations = readCitations(res);

  const parsed = extractJsonObject(answer);
  if (parsed === null) return fallback('unparseable', answer.slice(0, 200));

  const validated = validateRules(parsed);
  if (!validated.ok) return fallback('schema_invalid', undefined, validated.problems);

  const guarded = guardTightenOnly(opts.local, validated.rules);
  if (!guarded.ok) return fallback('would_widen', undefined, guarded.violations);

  return {
    policy: guarded.policy,
    provenance: {
      source: 'senso',
      reason: 'retrieved',
      retrievedAt,
      citations,
      tightened: guarded.tightened,
    },
  };
}
