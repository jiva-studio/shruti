/**
 * What a THROWN chat request actually was.
 *
 * A thrown request is only a CONNECTIVITY failure when it never reached a
 * responding server. `withNetworkErrorContext` renames fetch's
 * `TypeError: Failed to fetch` to a `NetworkError`; match by name so this
 * adapter needn't import the app-layer class. Everything else — notably the
 * failover client throwing `Error("HTTP 502")` when every candidate answers
 * 502/503/504 — is a SERVER fault, not the user's internet, and must NOT
 * surface as "check your connection" (#1843). The same convention is spelled
 * out in `infra/auth/capacitor/useCapacitorAuth.ts`.
 *
 * The distinction is not only wording: `code: "network"` is what arms the
 * bubble's reconnect auto-resend, and a backend outage must not re-send the
 * turn the moment connectivity blips.
 */

/** Failover throws `Error("HTTP 502")` — the status is the only thing it
 *  carries, so read it back rather than losing the response class. */
function statusFromMessage(message: string): number | null {
  const m = /\bHTTP (\d{3})\b/.exec(message)
  if (!m) return null
  const status = Number(m[1])
  return Number.isFinite(status) ? status : null
}

export type ChatTransportFailureCode = "network" | "server_unreachable" | `http_${number}`

/**
 * Classify the error a chat request threw into the `code` of the SSE `error`
 * frame the stream emits when no attempt produced a response.
 *
 *  - `network`            — the device never reached a server.
 *  - `http_<status>`      — every candidate answered with that status.
 *  - `server_unreachable` — a server-side fault with no status to report
 *                           (our own headers deadline, an empty candidate
 *                           list, anything else that is not connectivity).
 */
export function classifyChatTransportFailure(err: unknown): ChatTransportFailureCode {
  if ((err as { name?: unknown } | null)?.name === "NetworkError") return "network"
  if (err instanceof TypeError) return "network"
  if (err instanceof Error) {
    const status = statusFromMessage(err.message)
    if (status !== null) return `http_${status}`
  }
  return "server_unreachable"
}
