/**
 * Typed error for a non-2xx response from the ingest gateway, surfacing the
 * server's `{ error: { code, message } }` envelope so a caller can branch on
 * `code` (e.g. `not_pro` → open the paywall).
 *
 * It is part of the ingest contract rather than the HTTP client because
 * branching on it is an `instanceof`, which the use cases and the stores make
 * without reaching for an adapter.
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
