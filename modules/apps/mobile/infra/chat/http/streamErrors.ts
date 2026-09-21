import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import type { ChatStreamEvent } from "@lib/contracts"

/** An older server omits any of these; the caller still gets a message. */
async function readDetail(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const json = (await response.clone().json()) as { detail?: unknown } | null
    const d = json?.detail
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

/** Thrown, not yielded: no retry helps until the app updates. */
export async function throwProtocolMismatch(response: Response): Promise<never> {
  const d = await readDetail(response)
  const supported = Array.isArray(d?.supported)
    ? d.supported.map(toFiniteNumber).filter((n): n is number => n !== undefined)
    : undefined
  throw new ProtocolVersionMismatchError(supported, toFiniteNumber(d?.received))
}

export interface RateLimitDetail {
  tier?: string
  resetsAtEpoch?: number
  current?: number
  limit?: number
  keyType?: "user" | "ip"
}

/** What a 429 says beyond "too many" — the usage chip hydrates from it. */
export async function readRateLimitDetail(response: Response): Promise<RateLimitDetail> {
  const d = await readDetail(response)
  if (!d) return {}
  const keyType = d.key_type
  return {
    tier: typeof d.tier === "string" ? d.tier : undefined,
    resetsAtEpoch: typeof d.resets_at_epoch === "number" ? d.resets_at_epoch : undefined,
    current: typeof d.current === "number" ? d.current : undefined,
    limit: typeof d.limit === "number" ? d.limit : undefined,
    keyType: keyType === "user" || keyType === "ip" ? keyType : undefined,
  }
}

export function rateLimitedEvent(
  detail: RateLimitDetail,
  retryAfter: number | undefined
): ChatStreamEvent {
  return {
    type: "error",
    code: "rate_limited",
    message: "Too many requests",
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(detail.tier !== undefined ? { tier: detail.tier } : {}),
    ...(detail.resetsAtEpoch !== undefined ? { resetsAtEpoch: detail.resetsAtEpoch } : {}),
    ...(detail.current !== undefined ? { current: detail.current } : {}),
    ...(detail.limit !== undefined ? { limit: detail.limit } : {}),
    ...(detail.keyType !== undefined ? { keyType: detail.keyType } : {}),
  }
}

/** Only the quota-store outage is structural; a plain 503 stays retryable. */
export async function throwIfBackendUnavailable(response: Response): Promise<void> {
  const d = await readDetail(response)
  if (d?.code === "rate_limit_backend_unavailable") throw new BackendUnavailableError()
}
