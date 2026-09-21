import type { StreamError } from "./chatStreamFold.js"

/** The error event's optional fields, each present only when the server sent
 *  it — the store reads `undefined` and an absent key differently. */
export function streamErrorEvent(e: StreamError): {
  code: string
  message: string
  retryAfter?: number
  tier?: string
  resetsAtEpoch?: number
  current?: number
  limit?: number
  keyType?: "user" | "ip"
} {
  return {
    code: e.code,
    message: e.message,
    retryAfter: e.retryAfter,
    ...(e.tier !== undefined ? { tier: e.tier } : {}),
    ...(e.resetsAtEpoch !== undefined ? { resetsAtEpoch: e.resetsAtEpoch } : {}),
    ...(e.current !== undefined ? { current: e.current } : {}),
    ...(e.limit !== undefined ? { limit: e.limit } : {}),
    ...(e.keyType !== undefined ? { keyType: e.keyType } : {}),
  }
}
