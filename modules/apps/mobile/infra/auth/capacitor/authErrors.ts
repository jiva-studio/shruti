import { AccountDeleteError, EmailOtpError } from "@ports/app/auth.js"

/**
 * A thrown request is a CONNECTIVITY failure only when it never reached a
 * responding server. The composition root's `withNetworkErrorContext` renames
 * fetch's `TypeError: Failed to fetch` to a `NetworkError`, so match by name
 * and this adapter needn't import the app-layer class; a raw `TypeError`
 * covers a caller that wires an unwrapped request fn. Everything else — a
 * failover client throwing `Error("HTTP 5xx")` when every server is down — is
 * a server fault and must not surface as "check your connection".
 */
export function isConnectivityError(e: unknown): boolean {
  if ((e as { name?: unknown } | null)?.name === "NetworkError") return true
  return e instanceof TypeError
}

export function emailOtpErrorFromResponse(res: Response): EmailOtpError {
  const retryAfter = Number(res.headers.get("Retry-After")) || undefined
  switch (res.status) {
    case 400:
      return new EmailOtpError("invalid-email")
    case 401:
      return new EmailOtpError("invalid-code")
    case 429:
      return new EmailOtpError("throttled", retryAfter)
    case 503:
      return new EmailOtpError("disabled")
    default:
      return new EmailOtpError(res.status >= 500 ? "server" : "unknown")
  }
}

/** 410 means the server has already dropped the account — the caller clears
 *  local tokens so the follow-up wipe lands on a clean anonymous slate. */
export function accountDeleteErrorFromStatus(status: number): AccountDeleteError {
  if (status === 401) return new AccountDeleteError("unauthorized", 401)
  if (status === 410) return new AccountDeleteError("already-deleted", 410)
  if (status === 429) return new AccountDeleteError("rate-limited", 429)
  if (status >= 500) return new AccountDeleteError("server", status)
  return new AccountDeleteError("unknown", status)
}
