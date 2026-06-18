/**
 * Deny-list for benign, expected control-flow "errors" that must NOT become
 * Sentry issues.
 *
 * The app is written defensively: many operations can only be attempted and
 * caught (there's no cheap "exists?" probe), so a thrown value is often normal
 * control flow, not a bug — e.g. `Filesystem.mkdir` on a directory that already
 * exists, a `SELECT` against a table the (older) catalog DB doesn't have yet, a
 * `JSON.parse` of a corrupt/legacy cached blob with a sane fallback, an
 * `AbortError` from our own request timeouts, or a user-cancelled purchase.
 *
 * Both the `captureConsole` path (auto-escalated `console.error`) and the
 * explicit {@link reportError} helper run candidates through this so a benign
 * signature is dropped regardless of how it reached Sentry.
 */

// Message signatures that are always expected/benign across the app's adapters.
const EXPECTED_MESSAGE =
  /already exists|does not exist|no such (table|column)|no transaction is active|(start|begin) a transaction within a transaction|abort(ed|error)/i

// Error class names that are control-flow, not faults: request cancellation,
// user-cancelled IAP, and JSON.parse failures on cached/persisted blobs (every
// such site has an explicit fallback — a real syntax bug would surface as an
// unhandled error via the global handlers, not here).
const EXPECTED_NAMES = new Set(["AbortError", "PurchaseCancelledError", "SyntaxError"])

export function isExpectedError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name
    if (typeof name === "string" && EXPECTED_NAMES.has(name)) return true
  }
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return EXPECTED_MESSAGE.test(message)
}
