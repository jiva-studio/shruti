/**
 * Discriminated-union return type for recoverable failures (no throwing).
 * The error tag `E` is specified per call site — typically a string-literal
 * union so callers can narrow on it:
 *
 *     const r = load(id)
 *     if (!r.ok) {
 *       switch (r.error) {
 *         case "not-found": ...
 *         case "corrupt": ...
 *       }
 *     }
 *
 * Exceptions stay reserved for programmer errors.
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/** Unwrap a Result, throwing on error. Useful in tests. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`unwrap() called on error Result: ${JSON.stringify(result.error)}`)
  }
  return result.value
}
