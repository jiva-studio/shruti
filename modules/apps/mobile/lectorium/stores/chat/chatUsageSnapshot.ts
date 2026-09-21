import type { QuotaTier } from "@lib/domain"

/** Per-day usage counter the composer chip renders. */
export interface ChatUsageSnapshot {
  current: number
  limit: number
  /** Server time, displayed only — `expiresAtMs` decides whether the snapshot still holds. */
  resetsAtEpoch: number
  /** Device-clock instant the snapshot stops being current. */
  expiresAtMs: number
}

/**
 * Read a persisted usage snapshot. Returns null for anything unusable — a
 * malformed payload or one whose reset boundary has passed — and the caller
 * drops the stored key on null.
 */
export function parseChatUsageSnapshot(raw: string, nowMs: number): ChatUsageSnapshot | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const current = numberOr(parsed.current, -1)
  const limit = numberOr(parsed.limit, -1)
  const resetsAtEpoch = numberOr(parsed.resetsAtEpoch, -1)
  if (current < 0 || limit <= 0 || resetsAtEpoch <= 0) return null

  // Snapshots written before `expiresAtMs` existed fall back to the epoch.
  const stored = numberOr(parsed.expiresAtMs, 0)
  const expiresAtMs = stored > 0 ? stored : resetsAtEpoch * 1000
  if (expiresAtMs <= nowMs) return null

  return { current, limit, resetsAtEpoch, expiresAtMs }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback
}

/** Narrow the server's tier string; anything unknown collapses to undefined so the UI stays tier-agnostic. */
export function parseQuotaTier(raw: string | undefined): QuotaTier | undefined {
  if (raw === "anonymous" || raw === "free" || raw === "pro") return raw
  return undefined
}

// The tiers form a ladder, each step a strictly larger allowance. Ranking them
// tells an entitlement GAIN (sign-in, Pro upgrade) from a sideways identity
// move that lifts nothing.
const QUOTA_TIER_RANK: Record<QuotaTier, number> = { anonymous: 0, free: 1, pro: 2 }

export function outranksTier(to: QuotaTier, from: QuotaTier): boolean {
  return QUOTA_TIER_RANK[to] > QUOTA_TIER_RANK[from]
}
