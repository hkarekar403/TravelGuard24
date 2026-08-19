/**
 * Prava client — session creation, credential retrieval, and settlement reporting.
 *
 * Uses hosted checkout (`integration_type` omitted, no `callback_url`): Prava's URL is
 * opened in a browser and the outcome is collected by polling. Prava has no webhooks, so
 * polling is required regardless — which is precisely what lets the whole demo run on
 * localhost with no inbound network.
 */

import { request } from '../http.js';
import { parsePaymentResult } from './envelope.js';
import type {
  CreateSessionRequest,
  PaymentCredential,
  PaymentResult,
  PravaPort,
  PravaSession,
  ReportOutcome,
} from '../orchestrator/ports.js';

type RawSession = {
  session_id: string;
  order_id: string;
  iframe_url: string;
  expires_at: string;
};

type RawReport = {
  status?: string;
  txn_status?: string;
  visa_confirmation?: string;
};

export type PravaClientOptions = {
  baseUrl: string;
  secretKey: string;
  merchantName: string;
  merchantUrl: string;
  merchantCountry: string;
  /** How long the resulting mandate stays effective. Distinct from the 15-min session clock. */
  effectiveUntilMinutes?: number;
};

export function createPravaClient(opts: PravaClientOptions): PravaPort {
  const headers = { Authorization: `Bearer ${opts.secretKey}` };

  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) =>
    request<T>({
      method,
      url: `${opts.baseUrl}${path}`,
      headers,
      vendor: 'Prava',
      ...(body !== undefined ? { body } : {}),
    });

  return {
    async createSession(req: CreateSessionRequest): Promise<PravaSession> {
      const res = await call<RawSession>('POST', '/v1/sessions', {
        currency: req.currency,
        external_order_ref: req.externalOrderRef,
        // The exact quoted price. Never the policy budget cap.
        total_amount: req.totalAmount,
        description: req.description,
        user_email: req.userEmail,
        user_id: req.userId,
        // Card pre-selection is OPT-IN and off by default.
        //
        // An earlier note here said this BREAKS the checkout — a session sent with
        // `card: { card_id }` stalled on the order summary with no card and no passkey.
        // That diagnosis was wrong and is corrected here: a control session sent WITHOUT
        // the card object stalled on the same summary and then failed its security check,
        // so the summary screen is normal and the real fault was elsewhere. The pre-select
        // has never actually been shown to misbehave.
        //
        // It is still off by default only because every completed transaction so far was
        // made without it, i.e. it matches a known-good configuration — not because it is
        // suspect. It becomes worth turning on when a customer has more than one enrolled
        // card, since the checkout otherwise offers the default first.
        //
        // The real lesson from that episode stands: a 201 here says nothing about whether
        // a human can complete the checkout. Verify payment changes in a browser.
        ...(req.cardId ? { card: { card_id: req.cardId } } : {}),
        // `purchase_context` is an OBJECT, not an array.
        //
        // It was an array of entries until Prava restructured create-session (breaking
        // change; our last working call was 3 Aug 2026, this failed on 19 Aug with
        // `VAL_2001 purchase_context: Expected object, received array`). The entry shape
        // itself is unchanged — it just moved inside `custom`. The other mode is
        // `{ quote: true, quote_id }`, which builds the session from a /quote instead.
        //
        // NOTE how this error differed from the one recorded elsewhere: a bad field INSIDE
        // product_details also reports against `purchase_context`, which is why the standing
        // advice was "don't debug the array shape". The tell is the wording — "Expected
        // object, received array" is a type complaint about purchase_context itself and
        // cannot come from a nested field.
        purchase_context: {
          custom: [
            {
              effective_until_minutes: opts.effectiveUntilMinutes ?? 30,
              merchant_details: {
                country_code_iso2: opts.merchantCountry,
                url: opts.merchantUrl,
                // TravelGuard24 is the travel-seller of record under the TMC model: it
                // charges the traveller and settles with the carrier itself.
                name: opts.merchantName,
                category_code: '4722',
                category: 'Travel Agency',
              },
              // Only ONE entry — multi-merchant baskets are not expressible in a session.
              product_details: [
                {
                  quantity: 1,
                  description: req.description,
                  // The Duffel PNR. Comes back as `external_product_id`.
                  product_id: req.productId,
                  unit_price: req.totalAmount,
                },
              ],
            },
          ],
        },
      });

      return {
        sessionId: res.session_id,
        orderId: res.order_id,
        iframeUrl: res.iframe_url,
        expiresAt: res.expires_at,
      };
    },

    async getPaymentResult(sessionId: string): Promise<PaymentResult> {
      const raw = await call<unknown>('GET', `/v1/sessions/${sessionId}/payment-result`);
      return parsePaymentResult(raw);
    },

    async reportStatus(
      sessionId: string,
      credential: PaymentCredential,
      status: 'APPROVED' | 'DECLINED',
    ): Promise<ReportOutcome> {
      const res = await call<RawReport>('POST', `/v1/sessions/${sessionId}/report-status`, {
        product_statuses: [
          {
            product_ref_id: credential.productRefId,
            // `CANCELED`, one L. Prava's enum uses the American spelling and rejects the
            // British one outright:
            //   Expected 'COMPLETED' | 'FAILED' | 'CANCELED' | 'INPROGRESS' | 'PENDING'
            //   | 'ONHOLD', received 'CANCELLED'
            // Only reachable on the DECLINED branch, which is why every approved run
            // worked and this survived until the first rejection was executed.
            status: status === 'APPROVED' ? 'COMPLETED' : 'CANCELED',
          },
        ],
        txn_ref_id: credential.txnRefId,
        txn_type: 'PURCHASE',
        authorization_code: `TG24${credential.txnRefId.slice(-6).toUpperCase()}`,
        txn_status: status,
      });

      return {
        confirmed: res.status === 'confirmed' && res.txn_status === 'APPROVED',
        visaConfirmation: res.visa_confirmation ?? 'UNKNOWN',
      };
    },
  };
}
