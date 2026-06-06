/**
 * Discriminated Result type used by application use cases for recoverable
 * failures. Callers branch on `.ok` and get type-narrowed access to
 * `.value` or `.error`. Exceptions are reserved for programmer errors.
 */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
