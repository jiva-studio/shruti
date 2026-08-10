import { useShruti } from "@shruti/shruti.js"
import type { CdnServer } from "@lib/domain/servers.js"
import { getRegions } from "@shruti/services/regionsRegistry.js"

export interface ServerFallbackReturn {
  /**
   * Build the runtime fallback candidate list: the currently-active CDN
   * first (so the happy path hits it on the first attempt), then every
   * other region in registry order. Read fresh on every
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
   * (the activeServer watcher inside initShruti writes
   * preferredServerId on every flip) so the next session starts from
   * the working CDN. If every candidate fails the active server is
   * left set to whichever was tried last; the next call will rotate
   * again. Returns `null` on total failure — callers warn-log rather
   * than surface a `failed` UI state, since transcript prefetch is
   * opportunistic and the audio leg (the only user-visible commitment)
   * handles its own failure mode.
   */
  tryServers<T>(attempt: () => Promise<T>): Promise<T | null>
}

export function useServerFallback(): ServerFallbackReturn {
  const app = useShruti()

  function candidates(): CdnServer[] {
    const active = app.activeServer.value
    return [active, ...getRegions().filter((s) => s.id !== active.id)]
  }

  async function tryServers<T>(attempt: () => Promise<T>): Promise<T | null> {
    let lastError: unknown = null
    // Where we started. When every candidate fails the walk proves nothing
    // about any of them — offline, all three fail — so leaving the last one
    // tried as active would demote a healthy region on the strength of a dead
    // radio, and it sticks: the watcher persists it, and the startup probe
    // only checks the storage host, which is a different machine and answers
    // fine. A user could sit on the wrong region for days.
    const started = app.activeServer.value
    for (const server of candidates()) {
      // Flip activeServer before `attempt()` runs so the in-flight
      // request observes the new server when it builds its URL via
      // `storagePublicUrl`. Persistence to preferredServerId is
      // handled out-of-band by the activeServer watcher in
      // initShruti.
      app.setActiveServer(server)
      try {
        return await attempt()
      } catch (err) {
        lastError = err
      }
    }
    if (lastError !== null) {
      console.warn("[downloads] all CDNs failed:", lastError)
    }
    // Nothing worked, so nothing was learned. Put the choice back.
    app.setActiveServer(started)
    return null
  }

  return { candidates, tryServers }
}
