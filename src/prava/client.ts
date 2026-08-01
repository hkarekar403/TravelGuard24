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
        // Pre-selects the enrolled card so the checkout opens straight into the saved
        // card rather than a picker. Verified 201 against the live sandbox.
        card: { card_id: req.cardId },
        purchase_context: [
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
            // Only ONE purchase_context entry is supported — multi-merchant baskets
            // are not expressible in a single session.
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
            status: status === 'APPROVED' ? 'COMPLETED' : 'CANCELLED',
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
