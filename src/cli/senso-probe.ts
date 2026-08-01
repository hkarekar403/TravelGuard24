/**
 * Live probe for the Senso policy source.
 *
 *   npx tsx src/cli/senso-probe.ts ingest    # upload the policy document
 *   npx tsx src/cli/senso-probe.ts query     # ask for the rules and show what resolves
 *
 * Senso's public docs pin the base URL, the `X-API-Key` header and `POST /org/search`, but
 * not the ingest path or the response shapes. `ingest` therefore tries the plausible paths
 * and reports which one answers; `query` prints the raw envelope so the field names can be
 * read off a real response rather than guessed.
 *
 * Free of the booking flow entirely — no Prava, no Duffel, no quota.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../config.js';
import { ApiError, request } from '../http.js';
import {
  createSensoClient,
  extractJsonObject,
  guardTightenOnly,
  readAnswer,
  readCitations,
  resolvePolicy,
  validateRules,
} from '../policy/senso.js';
import type { Policy } from '../policy/types.js';

const BASE = 'https://apiv2.senso.ai/api/v1';
const ROOT = new URL('../../', import.meta.url);

function apiKey(): string {
  const env = loadEnvFile();
  const key = process.env['SENSO_API_KEY'] ?? env['SENSO_API_KEY'] ?? '';
  if (!key) throw new Error('Missing SENSO_API_KEY — add it to .env.local');
  return key;
}

const readPolicyDoc = (): string =>
  readFileSync(fileURLToPath(new URL('docs/acme-corp-travel-policy.md', ROOT)), 'utf8');

const readLocalPolicy = (): Policy =>
  JSON.parse(readFileSync(fileURLToPath(new URL('policy.json', ROOT)), 'utf8')) as Policy;

/**
 * Candidate ingest endpoints, most likely first. Each is tried once; the first non-404
 * wins. A 4xx that is not 404 still tells us the path exists and the body was wrong, which
 * is more useful than a silent failure.
 */
const INGEST_CANDIDATES = ['/content/raw', '/content', '/org/content', '/documents', '/ingest'];

async function ingest(): Promise<void> {
  const key = apiKey();
  const text = readPolicyDoc();
  console.log(`document: ${text.length} chars\n`);

  for (const path of INGEST_CANDIDATES) {
    process.stdout.write(`POST ${path} ... `);
    try {
      const res = await request<unknown>({
        method: 'POST',
        url: `${BASE}${path}`,
        headers: { 'X-API-Key': key },
        body: {
          title: 'Acme Corp Corporate Air Travel Policy (ACME-TRV-001 v1.4)',
          summary: 'Authoritative corporate air travel rules: budget cap, cabin class, advance purchase, approved carriers.',
          text,
          content: text,
        },
        timeoutMs: 30_000,
        vendor: 'senso',
      });
      console.log('OK');
      console.log(JSON.stringify(res, null, 2).slice(0, 1200));
      console.log(`\n=> ingest endpoint is ${path}`);
      return;
    } catch (err) {
      if (err instanceof ApiError) {
        console.log(`${err.status}`);
        // A non-404 means the path is real and only the body is wrong — worth seeing.
        if (err.status !== 404) console.log(`   ${JSON.stringify(err.body).slice(0, 400)}`);
      } else {
        console.log(err instanceof Error ? err.message : String(err));
      }
    }
  }
  console.log('\nNo candidate accepted. Ingest the document via the Senso dashboard or CLI instead;');
  console.log('the read path (query) is what the server actually uses.');
}

async function query(): Promise<void> {
  const key = apiKey();
  const local = readLocalPolicy();
  const client = createSensoClient(key, BASE, 30_000);

  console.log('--- raw response ---');
  const raw = await client.search(
    'What is the current corporate air travel policy? Return only the machine-readable JSON ' +
      'summary object with exactly these fields: currency, budgetCapMinor, allowedCabinClasses, ' +
      'minAdvanceDays, vendorAllowlist. Return raw JSON with no commentary.',
  );
  console.log(JSON.stringify(raw, null, 2).slice(0, 2000));

  console.log('\n--- parsed ---');
  const answer = readAnswer(raw);
  console.log(`answer field  : ${answer ? 'found' : 'MISSING — add its field name to readAnswer()'}`);
  console.log(`citations     : ${JSON.stringify(readCitations(raw))}`);

  if (answer) {
    const obj = extractJsonObject(answer);
    console.log(`json extracted: ${obj ? JSON.stringify(obj) : 'NONE'}`);
    if (obj) {
      const v = validateRules(obj);
      console.log(`schema        : ${v.ok ? 'valid' : `invalid — ${v.problems.join('; ')}`}`);
      if (v.ok) {
        const g = guardTightenOnly(local, v.rules);
        console.log(`guard         : ${g.ok ? `accepted (tightened: ${g.tightened.join(', ') || 'nothing'})` : `REJECTED — ${g.violations.join('; ')}`}`);
      }
    }
  }

  console.log('\n--- what the server would use ---');
  const resolved = await resolvePolicy({ local, client });
  console.log(`source   : ${resolved.provenance.source} (${resolved.provenance.reason})`);
  console.log(`version  : ${resolved.policy.version}`);
  console.log(`cap      : ${(resolved.policy.budgetCapMinor / 100).toFixed(2)} ${resolved.policy.currency}`);
  console.log(`cabins   : ${resolved.policy.allowedCabinClasses.join(', ')}`);
  console.log(`advance  : ${resolved.policy.minAdvanceDays} days`);
  console.log(`carriers : ${resolved.policy.vendorAllowlist.join(', ')}`);
  if (resolved.provenance.citations.length) console.log(`cited    : ${resolved.provenance.citations.join('; ')}`);
  if (resolved.provenance.rejected?.length) console.log(`rejected : ${resolved.provenance.rejected.join('; ')}`);
}

const command = process.argv[2];
const run = command === 'ingest' ? ingest : command === 'query' ? query : null;

if (!run) {
  console.error('usage: senso-probe.ts <ingest|query>');
  process.exit(1);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
