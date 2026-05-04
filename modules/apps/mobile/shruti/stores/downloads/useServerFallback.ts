import { useShruti } from "@shruti/shruti.js"
import { promotePreferredServer } from "@shruti/services/preferredServer.js"
import { SERVERS, type CdnServer } from "@lib/domain/servers.js"

export interface ServerFallbackReturn {
  /**
   * Build the runtime fallback candidate list: the currently-active CDN
   * first (so the happy path hits it on the first attempt), then every
   * other registered server in `SERVERS` order. Read fresh on every
   * call — `activeServer` is a `Ref` and may have been promoted by a
   * previous fallback in this session.
   */
  candidates(): CdnServer[]

  /**
   * Iterate every candidate server in priority order, promoting each to
   * active **before** invoking `attempt`. Resolves with the first server
   * that doesn't throw. Used for opaque transfer paths whose URL
   * construction is buried inside a repository (transcripts) and
   * therefore reads `activeServer.value` themselves — promoting the
   * server up-front is the only way to redirect them to the candidate.
   *
   * If a non-active candidate succeeds, the promotion is also persisted
   * to `IPreferences` (via `promotePreferredServer`) so the next session
   * starts from the working CDN. If every candidate fails the active
   * server is left set to whichever was tried last; the next call will
   * rotate again. Returns `null` on total failure — callers warn-log
   * rather than surface a `failed` UI state, since transcript prefetch
   * is opportunistic and the audio leg (the only user-visible
   * commitment) handles its own failure mode.
   */
  tryServers<T>(attempt: () => Promise<T>): Promise<T | null>
}

export function useServerFallback(): ServerFallbackReturn {
  const app = useShruti()

  function candidates(): CdnServer[] {
    const active = app.activeServer.value
    return [active, ...SERVERS.filter((s) => s.id !== active.id)]
  }

  async function tryServers<T>(attempt: () => Promise<T>): Promise<T | null> {
    let lastError: unknown = null
    for (const server of candidates()) {
      // Awaited so the persist happens before `attempt()` runs:
      // guarantees the in-flight request observes the new active
      // server when it builds its URL via `storagePublicUrl`.
      await promotePreferredServer(app, server)
      try {
        return await attempt()
      } catch (err) {
        lastError = err
      }
    }
    if (lastError !== null) {
      console.warn("[downloads] all CDNs failed:", lastError)
    }
    return null
  }

  return { candidates, tryServers }
}
