import type { MeView } from "@ports/app/auth.js"

/** How long a `/auth/me` round-trip is considered recent enough to skip another. */
const MAX_AGE_MS = 5 * 60 * 1000
const SETTLE_ATTEMPTS = 5
const SETTLE_DELAY_MS = 3000

export const TIMED_OUT = Symbol("timed-out")

/** The slice of the auth port the tier sync talks to. */
export interface TierSyncPort {
  fetchMe(): Promise<MeView | null>
  refreshTokens(): Promise<unknown>
}

export interface TierSyncDeps {
  /** Resolved per call — the port is created after the store. */
  readonly port: () => TierSyncPort
  /** The tier view currently cached in the JWT claim. */
  readonly cached: () => MeView
}

export interface TierSync {
  ensureFresh(opts?: { timeoutMs?: number }): Promise<void>
  syncOnResume(): Promise<void>
  invalidateAndSync(): void
}

/**
 * True when the server's view differs from the cached one. The expiry is
 * compared as well as the tier: a renewal keeps "pro" and only moves the
 * expiry forward, and checking the tier alone would leave the JWT on the
 * old, sooner expiry.
 */
export function hasTierDiverged(server: MeView, cached: MeView): boolean {
  return server.tier !== cached.tier || (server.tierExpiresAt ?? null) !== cached.tierExpiresAt
}

/** Resolve `p`, or {@link TIMED_OUT} after `ms`. Never leaves the timer armed. */
export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Keeps the cached subscription tier honest against `/auth/me`.
 *
 * The JWT claim is frozen at issue time, so a webhook-driven flip (a purchase
 * on another device, an expiry, a refund) only reaches the client on natural
 * rotation ~15 min later. Every probe here forces a token refresh the moment
 * the server's view diverges. Nothing throws: a failed probe is best-effort
 * and leaves the cached value in place.
 */
export function createTierSync(deps: TierSyncDeps): TierSync {
  let lastSyncAt = 0

  async function adopt(me: MeView | null): Promise<void> {
    if (!me) return
    lastSyncAt = Date.now()
    if (hasTierDiverged(me, deps.cached())) {
      await deps.port().refreshTokens()
    }
  }

  async function syncOnResume(): Promise<void> {
    try {
      await adopt(await deps.port().fetchMe())
    } catch (e) {
      console.warn("[auth] resume tier sync failed", e)
    }
  }

  /**
   * Bring the cache up to date before a tier-sensitive action (a chat send, a
   * paywall open). Closes the window where a resume and a tap land in the same
   * frame and the send goes out under a stale free-tier claim. On a timeout the
   * caller proceeds — the stale tier beats blocking the UI on a dead network.
   */
  async function ensureFresh({ timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (Date.now() - lastSyncAt < MAX_AGE_MS) return
    try {
      const me = await raceTimeout(deps.port().fetchMe(), timeoutMs)
      if (me === TIMED_OUT) {
        console.warn("[auth] ensureFresh timed out", { timeoutMs })
        return
      }
      await adopt(me)
    } catch (e) {
      console.warn("[auth] ensureFresh failed", e)
    }
  }

  async function probeOnce(): Promise<"settled" | "pending"> {
    try {
      const me = await deps.port().fetchMe()
      if (!me) return "settled"
      if (hasTierDiverged(me, deps.cached())) {
        await deps.port().refreshTokens()
        return "settled"
      }
      if (me.tier !== "free") return "settled"
    } catch (e) {
      console.warn("[auth] tier sync attempt failed", e)
    }
    return "pending"
  }

  /**
   * Probe until the server agrees, then freeze the cache. A single probe is
   * not enough at sign-in or right after a purchase: it would stamp the cache
   * while `/auth/me` still says "free", and the composer's own `ensureFresh`
   * would then short-circuit for five minutes — straight through the window
   * the webhook lands in.
   */
  async function syncUntilSettled(): Promise<void> {
    for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
      if ((await probeOnce()) === "settled") break
      if (i < SETTLE_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, SETTLE_DELAY_MS))
      }
    }
    lastSyncAt = Date.now()
  }

  /** Drop the cache and chase the server's view. Fire-and-forget; never throws. */
  function invalidateAndSync(): void {
    lastSyncAt = 0
    void syncUntilSettled()
  }

  return { ensureFresh, syncOnResume, invalidateAndSync }
}
