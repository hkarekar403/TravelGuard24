/**
 * Parsing Prava's `payment-result` envelope.
 *
 * This exists as its own module because the envelope's shape is the single most expensive
 * thing to get wrong in this integration, and none of it is guessable from the endpoint
 * name:
 *
 *   - Credentials are NOT top-level. They sit at `transactions[].line_items[]`.
 *   - The SESSION reports `awaiting_result` while the LINE ITEM reports
 *     `credentials_generated`. They are different fields with different vocabularies.
 *     Waiting for a line item to say `awaiting_result` hangs forever.
 *   - Credentials are present only while the session is `awaiting_result`. After
 *     `report-status` they are gone, so they must be read before reporting.
 */

import type { PaymentCredential, PaymentResult } from '../orchestrator/ports.js';

type RawLineItem = {
  txn_ref_id?: unknown;
  merchant_name?: unknown;
  merchant_url?: unknown;
  total_amount?: unknown;
  status?: unknown;
  token?: unknown;
  dynamic_cvv?: unknown;
  expiry_month?: unknown;
  expiry_year?: unknown;
  products?: Array<{ external_product_id?: unknown; product_ref_id?: unknown }>;
};

type RawEnvelope = {
  session_id?: unknown;
  status?: unknown;
  transactions?: Array<{ line_items?: RawLineItem[] }>;
};

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Pulls the credential out of a raw envelope, or null if it is not there yet.
 *
 * Returns null rather than throwing on a pending envelope: `transactions: []` is the
 * normal state of a session whose iframe nobody has opened, not an error.
 */
export function parseCredential(raw: unknown): PaymentCredential | null {
  const env = raw as RawEnvelope;
  const lineItem = env?.transactions?.[0]?.line_items?.[0];
  if (!lineItem) return null;

  const txnRefId = str(lineItem.txn_ref_id);
  const token = str(lineItem.token);
  const dynamicCvv = str(lineItem.dynamic_cvv);

  // A line item without these is a transaction that has started but not yet produced
  // credentials. Partial credentials are treated as absent — never as usable.
  if (!txnRefId || !token || !dynamicCvv) return null;

  return {
    txnRefId,
    productRefId: str(lineItem.products?.[0]?.product_ref_id) ?? '',
    merchantName: str(lineItem.merchant_name) ?? '',
    merchantUrl: str(lineItem.merchant_url) ?? '',
    totalAmount: str(lineItem.total_amount) ?? '',
    token,
    dynamicCvv,
    expiryMonth: str(lineItem.expiry_month) ?? '',
    expiryYear: str(lineItem.expiry_year) ?? '',
    // The Duffel PNR we sent as `product_id`, echoed back. A free join key between the
    // Prava transaction and the Duffel booking — no correlation id of our own needed.
    externalProductId: str(lineItem.products?.[0]?.external_product_id),
  };
}

export function parsePaymentResult(raw: unknown): PaymentResult {
  const env = raw as RawEnvelope;
  return {
    sessionId: str(env?.session_id) ?? '',
    status: str(env?.status) ?? 'unknown',
    credential: parseCredential(raw),
  };
}
