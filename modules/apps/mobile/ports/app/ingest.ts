/**
 * Typed error for a non-2xx response from the ingest gateway, surfacing the
 * server's `{ error: { code, message } }` envelope so a caller can branch on
 * `code` (e.g. `not_pro` → open the paywall).
 *
 * It lives here rather than beside the HTTP client because branching on it is
 * an `instanceof`, and a store reaching for the adapter to get the class is the
 * binding the composition root is supposed to own.
 */
export class IngestGatewayError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = "IngestGatewayError"
  }
}
