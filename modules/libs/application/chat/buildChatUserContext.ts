import type { TrackId } from "@lib/domain/core.js"
import type {
  IListeningSessionRepository,
  RecentTrackProgress,
} from "@lib/domain/ports/listeningSessionRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"

/** Server wire-format for one track in `recent_tracks`. Mirrors
 *  `api/chat.UserContextTrack` server-side. `percent` is the source of
 *  truth for progress — "completed" (percent >= 0.95) and "in-progress"
 *  (0.05 < percent < 0.95) are derived server-side, no separate flags. */
export interface UserContextTrackPayload {
  readonly track_id: string
  readonly position_ms: number | null
  readonly percent: number | null
  readonly last_played_at: string | null
}

export interface FocusFragmentPayload {
  readonly track_id: string
  readonly start_ms: number
  readonly end_ms: number
  readonly title?: string
}

/** Every timestamp in this payload (`now`, `recent_tracks[].last_played_at`)
 *  is ISO-8601 with the device's UTC offset — e.g.
 *  `"2026-05-17T19:42:00+03:00"`. Uniform format so the LLM can compare
 *  them without inferring a separate timezone field. The offset suffix
 *  replaces what would otherwise be a `tz_offset_minutes` field.
 *
 *  Notes are NOT sent. Chat exposes citations as `[cite:...]` chips
 *  the user can save from the action sheet, but the agent has no read
 *  side for notes — the field would be dead bytes in every request
 *  until a search-my-notes UI flow lands. */
export interface UserContextPayload {
  readonly current_track_id: string | null
  readonly now: string
  readonly recent_tracks: readonly UserContextTrackPayload[]
  readonly focus?: FocusFragmentPayload
}

const RECENT_LIMIT = 20

export interface BuildChatUserContextInput {
  /** Track id the user is currently engaged with (player open + recent
   *  activity). Pulled from the player store on the consumer side. */
  readonly currentTrackId: string | null
  /** One-off span override — outline-chapter tap or citation re-ask. */
  readonly focus?: FocusFragmentPayload
}

export interface BuildChatUserContextDeps {
  readonly listeningSessions: IListeningSessionRepository
  readonly tracks: ITrackRepository
}

/**
 * Assemble the on-device `UserContext` snapshot sent with each POST /chat.
 *
 * Read-only — never mutates the DB. Failure modes degrade gracefully:
 * any individual fetch that throws yields an empty array for that field
 * so a partial DB issue still produces a usable (if thinner) payload.
 *
 * `now` is the device's local wall-clock in ISO-8601 *with offset* — not
 * UTC — so the LLM can reason about "yesterday" in the user's timezone.
 */
export async function buildChatUserContext(
  input: BuildChatUserContextInput,
  deps: BuildChatUserContextDeps
): Promise<UserContextPayload> {
  const recentRows: readonly RecentTrackProgress[] = await deps.listeningSessions
    .listRecentTracksWithProgress(RECENT_LIMIT)
    .catch(() => [])

  const trackIds = recentRows.map((r) => r.trackId)
  const durations = await deps.tracks
    .getDurationsMs(trackIds as readonly TrackId[])
    .catch(() => new Map<TrackId, number>())

  const recent: UserContextTrackPayload[] = recentRows.map((r) => {
    const durationMs = durations.get(r.trackId as TrackId)
    const positionMs = Math.max(0, Math.floor(r.positionSec * 1000))
    const percent =
      durationMs && durationMs > 0
        ? Math.max(0, Math.min(1, positionMs / durationMs))
        : null
    return {
      track_id: r.trackId,
      position_ms: positionMs,
      percent,
      last_played_at: localIsoFromMs(r.endedAtMs),
    }
  })

  return {
    current_track_id: input.currentTrackId,
    now: localIsoNow(),
    recent_tracks: recent,
    ...(input.focus ? { focus: input.focus } : {}),
  }
}

/**
 * ISO-8601 with the device's UTC offset (e.g. "2026-05-17T19:42:00+03:00").
 * `Date.toISOString()` always emits Z (UTC) and loses the offset, which
 * is exactly what we need to preserve so the LLM can reason about
 * "yesterday" in the user's local wall-clock. Every timestamp in
 * UserContextPayload (`now`, `last_played_at`, `created_at`) goes
 * through this formatter — single uniform shape on the wire.
 */
function localIsoFromMs(ms: number): string {
  const d = new Date(ms)
  const offMin = -d.getTimezoneOffset() // sign-flipped: east-of-UTC positive
  const sign = offMin >= 0 ? "+" : "-"
  const abs = Math.abs(offMin)
  const offH = String(Math.floor(abs / 60)).padStart(2, "0")
  const offM = String(abs % 60).padStart(2, "0")
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${offH}:${offM}`
  )
}

function localIsoNow(): string {
  return localIsoFromMs(Date.now())
}
