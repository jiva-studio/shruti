import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"

/**
 * Why an add to the personal library was rejected — the four sentences the
 * user can act on differently.
 *
 *  - `offline` — the request never reached a server. The only one that is
 *                actually about the user's connection.
 *  - `auth`    — no access token, or the orchestrator refused the one we sent.
 *  - `timeout` — our own 15 s cap on the control-plane call elapsed.
 *  - `server`  — the orchestrator answered, badly (any other 4xx/5xx), or
 *                every candidate was transiently down.
 *  - `invalid` — the link itself is unusable; nothing was ever sent.
 */
export type AddByUrlFailureReason = "offline" | "server" | "auth" | "timeout" | "invalid"

/** Failover throws `Error("HTTP 502")` and carries the status nowhere else. */
function statusFromMessage(message: string): number | null {
  const m = /\bHTTP (\d{3})\b/.exec(message)
  if (!m) return null
  const status = Number(m[1])
  return Number.isFinite(status) ? status : null
}

function reasonForStatus(status: number): AddByUrlFailureReason {
  return status === 401 || status === 403 ? "auth" : "server"
}

/**
 * Classify what a rejected ingest submit really was, so the toast can say it.
 *
 * Every one of these used to collapse into `library.addError` — "check your
 * connection" — including a missing token, our own timeout, and any
 * orchestrator 4xx/5xx (#1844). Connectivity is recognised the same way the
 * auth adapter and the chat transport recognise it: by error SHAPE, since a
 * thrown `Error("HTTP 5xx")` from the failover client is a server fault and
 * not the user's internet.
 */
export function classifyIngestFailure(err: unknown): AddByUrlFailureReason {
  if ((err as { name?: unknown } | null)?.name === "NetworkError") return "offline"
  if (err instanceof TypeError) return "offline"
  if (err instanceof IngestGatewayError) {
    if (err.code === "timeout") return "timeout"
    if (err.code === "no_token") return "auth"
    return reasonForStatus(err.status)
  }
  if (err instanceof Error) {
    const status = statusFromMessage(err.message)
    if (status !== null) return reasonForStatus(status)
  }
  return "server"
}
