import type { ChatStreamEvent } from "@lib/contracts"
import { parseSseBlock } from "./sseParser.js"
import { resolveAccessToken, type AccessTokenProvider, type ChatRequest } from "./chatHttp.js"

export interface StoredTurnFrame {
  readonly event: string
  readonly data: string
}

/** A turn fetched from the server's turn store. `running` ⇒ still
 *  generating (keep polling); `done` / `error` ⇒ replay `events` to
 *  rebuild the message. */
export interface BufferedTurn {
  readonly state: "running" | "done" | "error"
  readonly events: readonly StoredTurnFrame[]
}

/**
 * Poll a turn's buffered result by the assistant message id — its
 * hyphenless form is the server trace id (same derivation as feedback).
 * Returns null on 404: the turn was never received, its 24h buffer
 * expired, or it isn't ours. Used by the resume flow when the client
 * reconnects after a background / app-kill that dropped the live stream.
 */
export async function getTurn(
  messageId: string,
  opts: { request: ChatRequest; getAccessToken: AccessTokenProvider; signal?: AbortSignal }
): Promise<BufferedTurn | null> {
  const token = await resolveAccessToken(opts.getAccessToken)
  const traceId = messageId.replace(/-/g, "").toLowerCase()
  const response = await opts.request(`/chat/turn/${traceId}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: opts.signal,
  })
  if (response.status === 404) return null
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`getTurn failed: ${response.status} ${text || response.statusText}`)
  }
  const json = (await response.json()) as { state?: unknown; events?: unknown }
  const state: BufferedTurn["state"] =
    json.state === "done" || json.state === "error" ? json.state : "running"
  const events: StoredTurnFrame[] = Array.isArray(json.events)
    ? (json.events as unknown[]).filter(
        (e): e is StoredTurnFrame =>
          !!e &&
          typeof (e as StoredTurnFrame).event === "string" &&
          typeof (e as StoredTurnFrame).data === "string"
      )
    : []
  return { state, events }
}

/**
 * Explicit Stop for a turn — really cancel it server-side (vs a passive
 * disconnect, which lets it finish and buffer). Best-effort: a failure
 * just means the turn may run to completion.
 */
export async function cancelTurn(
  messageId: string,
  opts: { request: ChatRequest; getAccessToken: AccessTokenProvider; signal?: AbortSignal }
): Promise<void> {
  try {
    const token = await resolveAccessToken(opts.getAccessToken)
    const traceId = messageId.replace(/-/g, "").toLowerCase()
    await opts.request(`/chat/turn/${traceId}`, {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: opts.signal,
    })
  } catch {
    // Best-effort — the local abort already stopped the UI; the server
    // turn lapses on its own if this never lands.
  }
}

/**
 * Parse one buffered SSE frame ({event, data}) back into a typed
 * ChatStreamEvent by reusing the live-stream block parser — a replayed
 * turn folds through the EXACT same logic as the live stream, so no
 * second parser can drift from the wire contract.
 */
export function parseStoredFrame(frame: StoredTurnFrame): ChatStreamEvent | null {
  return parseSseBlock(`event: ${frame.event}\ndata: ${frame.data}`)
}
