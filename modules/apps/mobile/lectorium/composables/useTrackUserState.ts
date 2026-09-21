import { useLectorium } from "@lectorium/lectorium.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { buildChatUserContext, type FocusFragmentPayload, type UserContextPayload } from "@usecases"

// Re-export the wire-format types so existing callers (chat store,
// chat client) keep importing them from the composable's module path.
export type { FocusFragmentPayload, UserContextPayload, UserContextTrackPayload } from "@usecases"

/**
 * Vue-reactive bridge to the chat `UserContext` builder. The
 * use-case itself (`buildChatUserContext`) is plain TS — this
 * composable plugs the player state in and forwards the repository
 * bundle from `useLectorium()`.
 *
 * Owns no SQL. Used by:
 * - useChatStore (buildUserContext on each send)
 * - ChatView.controller (listRecent(1) for the "recap last lecture"
 *   suggestion chip)
 */
export function useTrackUserState() {
  const app = useLectorium()
  const player = usePlayerStore()

  /** The track id the user is currently engaged with: player open and
   *  either playing or recently active. Returns null when idle. */
  function currentTrackId(): string | null {
    if (!player.open) return null
    if (player.playing) return player.trackId ?? null
    if ((player.positionMs ?? 0) > 0) return player.trackId ?? null
    return null
  }

  function buildUserContext(focus?: FocusFragmentPayload): Promise<UserContextPayload> {
    const repos = app.repositories()
    return buildChatUserContext(
      { currentTrackId: currentTrackId(), focus },
      {
        listeningSessions: repos.listeningSessions,
        tracks: repos.tracks,
        now: Date.now,
      }
    )
  }

  /** Lightweight presence check — does the user DB have any
   *  listening-session rows? `length > 0` callers can short-circuit
   *  with a small `limit` (1 is enough). Implemented on top of the
   *  same repo method the use-case uses, so the suggestion chip and
   *  the chat UserContext share the source of truth. */
  async function listRecent(limit: number): Promise<readonly { trackId: string }[]> {
    const repos = app.repositories()
    const rows = await repos.listeningSessions.listRecentTracksWithProgress(limit)
    return rows.map((r) => ({ trackId: r.trackId }))
  }

  return { buildUserContext, listRecent, currentTrackId }
}
