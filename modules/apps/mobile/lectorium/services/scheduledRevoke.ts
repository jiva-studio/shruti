import type { IPreferences } from "@ports/app/index.js"

/**
 * Fire-and-forget queue for `/auth/migrate-revoke` calls on the *source*
 * region after a successful migrate-in. We can't block the migration UI
 * on the source-side cleanup — if the source VPS is briefly unreachable
 * the user shouldn't see a half-failed migration toast. Instead we
 * persist the (regionId, bearer) pair to Capacitor Preferences and
 * drain on every app start until each entry returns terminal status
 * (204 deleted | 410 already gone) or hits `MAX_ATTEMPTS`.
 *
 * `MAX_ATTEMPTS` is the practical cap; if the source region is
 * permanently unreachable, eventual TTL cleanup on the source's auth
 * service reaps the orphan user. We never crash, retry forever, or
 * block the user.
 */

const KEY = "auth.pendingRevoke"
const MAX_ATTEMPTS = 30

interface PendingRevokeEntry {
  regionId: string
  bearer: string
  attempts: number
  /** ms epoch — for diagnostics only; we don't expire on age. */
  createdAt: number
}

export interface ScheduledRevokeDeps {
  prefs: IPreferences
  /** Same resolver passed into `useCapacitorAuth` — looks up an
   *  auth base URL for a region different from `activeServer`. */
  resolveAuthBaseUrl: (regionId: string) => string
  /** Injection seam for tests. Defaults to global `fetch`. */
  fetch?: typeof fetch
}

export interface ScheduledRevoke {
  /** Persist a new revoke target. Called once after migrate-in succeeds. */
  enqueue(regionId: string, bearer: string): Promise<void>
  /** Walk the queue, POST `/auth/migrate-revoke` for each entry, drop
   *  terminal entries, re-write the queue with attempts bumped on the
   *  rest. Safe to call concurrently with enqueue — each does its own
   *  load-modify-store. Last-writer-wins is acceptable: a missed bump
   *  just makes one entry retry one extra time. */
  drain(): Promise<void>
}

export function makeScheduledRevoke(deps: ScheduledRevokeDeps): ScheduledRevoke {
  const fetchImpl = deps.fetch ?? fetch

  async function read(): Promise<PendingRevokeEntry[]> {
    const raw = await deps.prefs.get(KEY)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PendingRevokeEntry[]) : []
    } catch {
      return []
    }
  }

  async function write(queue: PendingRevokeEntry[]): Promise<void> {
    if (queue.length === 0) {
      await deps.prefs.remove(KEY)
      return
    }
    await deps.prefs.set(KEY, JSON.stringify(queue))
  }

  async function enqueue(regionId: string, bearer: string): Promise<void> {
    const queue = await read()
    queue.push({ regionId, bearer, attempts: 0, createdAt: Date.now() })
    await write(queue)
  }

  async function drain(): Promise<void> {
    const queue = await read()
    if (queue.length === 0) return
    const next: PendingRevokeEntry[] = []
    for (const entry of queue) {
      if (entry.attempts >= MAX_ATTEMPTS) {
        // Give up silently — source-side TTL cron reaps the orphan.
        continue
      }
      let url: string
      try {
        url = `${deps.resolveAuthBaseUrl(entry.regionId)}/migrate-revoke`
      } catch {
        // Region id no longer in the registry (config rolled). Drop
        // the entry rather than retry forever — operator-level concern.
        continue
      }
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${entry.bearer}` },
        })
        if (res.status === 204 || res.status === 410) {
          // 204 deleted | 410 already gone — both terminal success.
          continue
        }
        next.push({ ...entry, attempts: entry.attempts + 1 })
      } catch {
        next.push({ ...entry, attempts: entry.attempts + 1 })
      }
    }
    await write(next)
  }

  return { enqueue, drain }
}
