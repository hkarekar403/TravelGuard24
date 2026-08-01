/**
 * Duffel client — discovery, hold orders, and the agency-settlement leg.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: Duffel's CARD payment path. It is structurally
 * unavailable to us and was ruled out empirically, not by preference —
 * `api.duffel.cards/payments/cards` returns `403 unavailable_feature` on a test key
 * (PCI-gated at the account level), and `POST /air/payments` with `type: card` returns
 * `422` demanding a `card_id` that only that 403'ing endpoint can mint. The
 * `three_d_secure_session_id` alternative also requires a `card_id`, so the loop is
 * closed. We settle with `type: balance`, which is what a pre-funded agency balance is
 * for.
 */

import { request } from '../http.js';
import { isHoldEligible, type Offer } from '../policy/types.js';
import type {
  BalancePayment,
  DuffelPort,
  HoldOrder,
  OrderDocuments,
  Passenger,
  SearchRequest,
} from '../orchestrator/ports.js';

type Envelope<T> = { data: T };

type RawOrder = {
  id: string;
  booking_reference: string;
  total_amount: string;
  total_currency: string;
  payment_status?: {
    // NOTE: nested under payment_status, not top-level on the order.
    awaiting_payment?: boolean;
    payment_required_by?: string;
  };
  documents?: Array<{ type?: string; unique_identifier?: string }>;
};

export function createDuffelClient(opts: { baseUrl: string; apiKey: string }): DuffelPort {
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    // Pinning the version is what makes a vendor-side change a visible break rather
    // than a silent one.
    'Duffel-Version': 'v2',
  };

  const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number) =>
    request<T>({
      method,
      url: `${opts.baseUrl}${path}`,
      headers,
      vendor: 'Duffel',
      ...(body !== undefined ? { body } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });

  return {
    async search(req: SearchRequest): Promise<Offer[]> {
      // `return_offers=true` avoids a second round trip. A SYD-LHR return search takes
      // ~20s and returns ~1,600 offers, so the timeout is generous on purpose.
      const res = await call<Envelope<{ offers: Offer[] }>>(
        'POST',
        '/air/offer_requests?return_offers=true',
        {
          data: {
            slices: [
              { origin: req.origin, destination: req.destination, departure_date: req.departureDate },
              { origin: req.destination, destination: req.origin, departure_date: req.returnDate },
            ],
            cabin_class: req.cabinClass,
            passengers: [{ type: 'adult' }],
          },
        },
        120_000,
      );
      const offers = res.data.offers ?? [];

      // Drop offers that cannot become a hold order. About two thirds of a live result
      // set requires instant payment, and requesting `type: hold` against one fails with
      // `422 invalid_order_create_type` — a message that points at the request body and
      // says nothing about the offer, so it reads as a malformed request rather than an
      // unbookable fare. Filtering here keeps the policy gate deciding policy, not
      // vendor capability.
      return offers.filter(isHoldEligible);
    },

    async refreshOffer(offerId: string): Promise<Offer> {
      const res = await call<Envelope<Offer>>('GET', `/air/offers/${offerId}?return_available_services=false`);
      return res.data;
    },

    async createHoldOrder(
      offerId: string,
      passenger: Passenger,
      metadata: Record<string, string>,
    ): Promise<HoldOrder> {
      // The passenger id is minted by Duffel against the offer and must be echoed back
      // exactly; it cannot be invented.
      const offer = await call<Envelope<{ passengers: Array<{ id: string }> }>>(
        'GET',
        `/air/offers/${offerId}?return_available_services=false`,
      );
      const passengerId = offer.data.passengers[0]?.id;
      if (!passengerId) throw new Error(`Offer ${offerId} returned no passengers`);

      const res = await call<Envelope<RawOrder>>('POST', '/air/orders', {
        data: {
          type: 'hold', // Reserves seats and issues a real PNR at zero payment.
          selected_offers: [offerId],
          passengers: [
            {
              id: passengerId,
              title: passenger.title,
              given_name: passenger.givenName,
              family_name: passenger.familyName,
              born_on: passenger.bornOn,
              gender: passenger.gender,
              phone_number: passenger.phoneNumber,
              email: passenger.email,
            },
          ],
          metadata,
        },
      });

      const order = res.data;
      return {
        id: order.id,
        bookingReference: order.booking_reference,
        totalAmount: order.total_amount,
        totalCurrency: order.total_currency,
        awaitingPayment: order.payment_status?.awaiting_payment ?? false,
        paymentRequiredBy: order.payment_status?.payment_required_by ?? '',
      };
    },

    async payFromBalance(orderId: string, amount: string, currency: string): Promise<BalancePayment> {
      // The DOCUMENTED SINGULAR `payment` object, with `order_id` as its sibling inside
      // `data`. Confirmed 201 on two separate bookings. The `payments[]` ARRAY form
      // exists but is only useful for surfacing the card path's true error message —
      // do not "fix" this to an array.
      const res = await call<Envelope<{ id: string; status?: string }>>('POST', '/air/payments', {
        data: {
          order_id: orderId,
          payment: { type: 'balance', amount, currency },
        },
      });
      return { id: res.data.id, status: res.data.status ?? 'succeeded' };
    },

    async getOrder(orderId: string): Promise<OrderDocuments> {
      const res = await call<Envelope<RawOrder & { paid_at?: string | null }>>('GET', `/air/orders/${orderId}`);
      const order = res.data;
      return {
        documents: (order.documents ?? []).map((d) => ({
          type: d.type ?? '',
          uniqueIdentifier: d.unique_identifier ?? '',
        })),
        paidAt: order.paid_at ?? null,
        awaitingPayment: order.payment_status?.awaiting_payment ?? false,
        bookingReference: order.booking_reference,
      };
    },
  };
}
