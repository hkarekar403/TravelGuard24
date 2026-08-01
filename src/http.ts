/**
 * Minimal HTTP helper shared by both vendor clients.
 *
 * Deliberately thin — no retries. Every call in the booking flow either creates money
 * movement or a reservation, and blindly retrying a `POST /air/payments` or a
 * `create-session` is worse than failing loudly. Idempotency would have to come first.
 */

export class ApiError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number,
    readonly body: unknown,
    readonly requestId?: string | undefined,
  ) {
    super(
      `${vendor} ${status}${requestId ? ` (request id ${requestId})` : ''}: ${
        typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)
      }`,
    );
    this.name = 'ApiError';
  }
}

export type RequestOptions = {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  vendor: string;
};

export async function request<T>(opts: RequestOptions): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000);

  try {
    const response = await fetch(opts.url, {
      method: opts.method,
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      // Duffel echoes a request id that their support asks for by name — keep it.
      throw new ApiError(opts.vendor, response.status, parsed, response.headers.get('x-request-id') ?? undefined);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}
