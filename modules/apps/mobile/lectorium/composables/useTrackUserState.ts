import { useLectorium } from "@lectorium/lectorium.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"

/* -------------------------------------------------------------------------- */
/*                              Wire-format types                             */
/* -------------------------------------------------------------------------- */

/** Sent on every POST /chat. Matches `api/chat.UserContext` on the server. */
export interface UserContextTrackPayload {
  readonly track_id: string
  readonly position_ms: number | null
  readonly percent: number | null
  readonly last_played_at: string | null
  readonly completed: boolean
}

export interface UserNotePayload {
  readonly track_id: string | null
  readonly time_start_ms: number | null
  readonly time_end_ms: number | null
  readonly text: string
  readonly created_at: string | null
}

export interface FocusFragmentPayload {
  readonly track_id: string
  readonly start_ms: number
  readonly end_ms: number
  readonly title?: string
}

export interface UserContextPayload {
  readonly current_track_id: string | null
  /** ISO-8601 with offset — anchor for relative-time queries on the server. */
  readonly now: string
  /** `Date.getTimezoneOffset()` — minutes WEST of UTC (sign matches JS). */
  readonly tz_offset_minutes: number
  readonly recent_tracks: readonly UserContextTrackPayload[]
  readonly in_progress: readonly UserContextTrackPayload[]
  readonly recent_notes: readonly UserNotePayload[]
  readonly focus?: FocusFragmentPayload
}

/* -------------------------------------------------------------------------- */
/*                                 Constants                                  */
/* -------------------------------------------------------------------------- */

const RECENT_LIMIT = 20
const IN_PROGRESS_LIMIT = 10
const NOTES_LIMIT = 30

/* -------------------------------------------------------------------------- */
/*                                  Composable                                */
/* -------------------------------------------------------------------------- */

/**
 * Collects the user's listening + notes state from local SQLite into a
 * shape the chat service can consume. Read-only — does not mutate any
 * stores or tables.
 *
 * Sources of truth:
 * - `listening_sessions` (migration 005) — recent listening, progress
 * - `playlist_items`     (migration 003) — item_id → track_id mapping
 * - `notes`              (migration 002) — saved notes
 * - `usePlayerStore`     — currently-active item (last 30 min)
 *
 * Track durations are fetched from the content DB to compute percent
 * completion; missing values silently degrade to `percent: null`.
 */
export function useTrackUserState() {
  const app = useLectorium()
  const player = usePlayerStore()

  function userDb() {
    const db = app.databases.user
    if (!db) throw new Error("useTrackUserState: user DB is not open yet")
    return db
  }

  function contentDb() {
    const db = app.databases.content
    if (!db) throw new Error("useTrackUserState: content DB is not open yet")
    return db
  }

  /**
   * Latest listening_sessions per item_id, joined to playlist_items for
   * the track_id, sorted by most-recent ended_at.
   */
  async function _listRecentRows(
    limit: number
  ): Promise<
    Array<{ track_id: string; to_position: number; ended_at: number }>
  > {
    const rows = await userDb().query<{
      track_id: string
      to_position: number
      ended_at: number
    }>(
      `SELECT pi.track_id AS track_id,
              MAX(ls.ended_at)        AS ended_at,
              -- to_position from the row that has the latest ended_at
              (SELECT ls2.to_position FROM listening_sessions ls2
                WHERE ls2.item_id = ls.item_id
                ORDER BY ls2.ended_at DESC LIMIT 1) AS to_position
         FROM listening_sessions ls
         JOIN playlist_items pi ON pi.id = ls.item_id
        GROUP BY ls.item_id
        ORDER BY ended_at DESC
        LIMIT ?`,
      [limit]
    )
    return rows
  }

  /**
   * Pull durations (ms) for the given track_ids from the content DB.
   * Returns a map track_id → duration_ms (0 / missing entries are
   * silently absent — callers should default to null percent).
   */
  async function _durations(trackIds: readonly string[]): Promise<Map<string, number>> {
    if (trackIds.length === 0) return new Map()
    const placeholders = trackIds.map(() => "?").join(",")
    const rows = await contentDb().query<{ track_id: string; audio_duration: number | null }>(
      `SELECT track_id, MAX(audio_duration) AS audio_duration
         FROM track_variants
         WHERE track_id IN (${placeholders})
         GROUP BY track_id`,
      [...trackIds]
    )
    const out = new Map<string, number>()
    for (const r of rows) {
      if (r.audio_duration && r.audio_duration > 0) {
        out.set(r.track_id, r.audio_duration)
      }
    }
    return out
  }

  function _toPayload(
    row: { track_id: string; to_position: number; ended_at: number },
    durations: Map<string, number>
  ): UserContextTrackPayload {
    const durationMs = durations.get(row.track_id)
    const positionMs = Math.max(0, Math.floor(row.to_position * 1000))
    const percent =
      durationMs && durationMs > 0
        ? Math.max(0, Math.min(1, positionMs / durationMs))
        : null
    return {
      track_id: row.track_id,
      position_ms: positionMs,
      percent,
      last_played_at: new Date(row.ended_at * 1000).toISOString(),
      completed: percent !== null && percent >= 0.95,
    }
  }

  async function listRecent(limit: number = RECENT_LIMIT): Promise<UserContextTrackPayload[]> {
    const rows = await _listRecentRows(limit)
    const durations = await _durations(rows.map((r) => r.track_id))
    return rows.map((r) => _toPayload(r, durations))
  }

  async function listInProgress(
    limit: number = IN_PROGRESS_LIMIT
  ): Promise<UserContextTrackPayload[]> {
    const recent = await listRecent(Math.max(limit, RECENT_LIMIT))
    return recent
      .filter((t) => t.percent !== null && t.percent > 0.05 && t.percent < 0.95)
      .slice(0, limit)
  }

  async function listRecentNotes(limit: number = NOTES_LIMIT): Promise<UserNotePayload[]> {
    const rows = await userDb().query<{
      track_id: string
      text: string
      time_start: number
      time_end: number
      created_at: number
    }>(
      `SELECT track_id, text, time_start, time_end, created_at
         FROM notes
         ORDER BY created_at DESC
         LIMIT ?`,
      [limit]
    )
    return rows.map((r) => ({
      track_id: r.track_id,
      time_start_ms: Math.max(0, Math.floor(r.time_start)),
      time_end_ms: Math.max(0, Math.floor(r.time_end)),
      text: r.text,
      created_at: new Date(r.created_at).toISOString(),
    }))
  }

  /**
   * The track the user is currently engaged with: player is open and
   * either playing or was active in the last 30 minutes. Returns null
   * if nothing recent.
   */
  function currentTrack(): string | null {
    if (!player.open) return null
    if (player.playing) return player.trackId ?? null
    // Player open but paused — still counts if positionMs > 0 (engagement signal).
    if ((player.positionMs ?? 0) > 0) return player.trackId ?? null
    return null
  }

  /** One-shot snapshot to send with a POST /chat.
   *
   * `focus` is an optional one-off override: when the user tapped a
   * specific span (outline chapter, citation chip) the caller passes it
   * here so the agent retells THAT span instead of guessing context. */
  async function buildUserContext(
    focus?: FocusFragmentPayload
  ): Promise<UserContextPayload> {
    const [recent, inProgress, notes] = await Promise.all([
      listRecent(RECENT_LIMIT).catch(() => []),
      listInProgress(IN_PROGRESS_LIMIT).catch(() => []),
      listRecentNotes(NOTES_LIMIT).catch(() => []),
    ])
    const payload: UserContextPayload = {
      current_track_id: currentTrack(),
      now: localIsoNow(),
      tz_offset_minutes: new Date().getTimezoneOffset(),
      recent_tracks: recent,
      in_progress: inProgress,
      recent_notes: notes,
      ...(focus ? { focus } : {}),
    }
    return payload
  }

  /**
   * ISO-8601 with the device's UTC offset (e.g. "2026-05-17T19:42:00+03:00").
   * `Date.toISOString()` always emits Z (UTC) and loses the offset, which
   * is exactly what we need to preserve for the LLM to reason about
   * "yesterday" in the user's local wall-clock.
   */
  function localIsoNow(): string {
    const d = new Date()
    const offMin = -d.getTimezoneOffset() // sign-flipped so east-of-UTC is positive
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

  return {
    listRecent,
    listInProgress,
    listRecentNotes,
    currentTrack,
    buildUserContext,
  }
}
