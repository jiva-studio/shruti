import type { TrackId } from "@lib/domain/core.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { notificationIdFor } from "../hash.js"
import { resolveSessionId } from "../sessions.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

/** Single action card per message — the "resume" button. */
const ACTION_ID = "main"
/** How many recent listening entries to scan for an abandoned track.
 *  Matches the horizon used by `next_shloka` / the heatmap. */
const RECENT_LIMIT = 10
const DAY_MS = 86_400_000
/** Fire the reminder ~a day after the user walked away from a lecture —
 *  long enough to read as "you didn't come back", short enough to still
 *  be relevant. */
const FIRE_DELAY_MS = DAY_MS
/** At most one unfinished-lecture nudge every 3 days, so a user who
 *  habitually leaves things half-listened isn't buried in pushes. */
const COOLDOWN_MS = 3 * DAY_MS
/** Progress band that counts as "started but not finished". Below the
 *  floor the user barely sampled it; above the ceiling they're
 *  effectively done and a "come back" nudge would be wrong. */
const MIN_PROGRESS = 0.05
const MAX_PROGRESS = 0.9

/** Catalog title in the user's locale, falling back to any variant. */
function localizedTitle(track: Track, locale: string): string {
  const lang = locale.startsWith("en") ? "en" : "ru"
  const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0] ?? null
  return variant?.title ?? ""
}

/** Fraction of the track the user has listened to, or null when the
 *  track has no measurable audio length. */
function progressFraction(track: Track, positionSec: number): number | null {
  const durationMs = maxAudioDurationMs(track)
  if (durationMs <= 0) return null
  return (positionSec * 1000) / durationMs
}

const SESSION_CONFIG = {
  id: "unfinished_lecture" as const,
  enabled: true,
  mode: "pre_baked" as const,
  prep_window_hours: 24,
  refresh_if_older_than_hours: 24,
  session_strategy: "new_session" as const,
  cooldown_hours: 72,
}

/**
 * Re-engage the user with a lecture they started but never finished.
 *
 * Like `inactivity`, this fires while the user is GONE, so detection
 * runs in `onAppPause` rather than the foreground tick: when the app
 * suspends we look for the most recent track left in the 5–90 % band,
 * mint a proactive row, and schedule a LocalNotification a day out
 * ("You haven't finished «XXXX» — return and complete it"). On the next
 * resume the validator cancels the alarm if the track was meanwhile
 * finished.
 *
 * The chat card the notification deep-links to carries a
 * `queue_next_track` action so a tap drops the lecture back at the front
 * of the queue; the player resumes from the saved position.
 */
const handler: ProactiveRuleHandler = {
  id: "unfinished_lecture",

  async detect() {
    // Away-only — a foreground tick would always look at a user who is
    // right here, with nothing to "come back" to.
    return []
  },

  async onAppPause(ctx) {
    const app = useLectorium()
    const repo = ctx.repos.proactiveState
    const recent = await repo.listRecentByRule("unfinished_lecture", 1)
    if (recent.length > 0 && ctx.nowMs - recent[0].createdAt < COOLDOWN_MS) return

    const progress = await ctx.repos.listeningSessions.listRecentTracksWithProgress(RECENT_LIMIT)
    if (progress.length === 0) return
    const tracksById = await ctx.repos.tracks.getByIds(progress.map((r) => r.trackId))

    let target: Track | null = null
    for (const r of progress) {
      const track = tracksById.get(r.trackId)
      if (!track || track.hidden) continue
      const fraction = progressFraction(track, r.positionSec)
      if (fraction === null || fraction < MIN_PROGRESS || fraction > MAX_PROGRESS) continue
      target = track
      break
    }
    if (target === null) return

    // A notification with no lecture name ("You haven't finished «»") is
    // worse than none — skip when the catalog title is missing.
    const title = localizedTitle(target, ctx.locale)
    if (title === "") return

    const trackId = target.id
    const existing = await repo.findByRuleAndDate("unfinished_lecture", trackId)
    if (existing !== null) return

    const fireAt = new Date(ctx.nowMs + FIRE_DELAY_MS)
    const visibleAtSec = Math.floor(fireAt.getTime() / 1000)
    const sessionTitle = ctx.t("chat.proactiveSessionTitleUnfinishedLecture")
    const sessionId = await resolveSessionId(
      { config: SESSION_CONFIG, handler },
      {
        ruleDate: trackId,
        visibleAt: visibleAtSec,
        notify: true,
        sessionTitleOverride: sessionTitle,
        templateContext: {},
      },
      ctx.nowMs,
      ctx.repos.chatSessions
    )
    const chatMessageId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    const created = await repo.create({
      chatMessageId: chatMessageId as never,
      sessionId,
      role: "assistant",
      content: "",
      createdAt: ctx.nowMs,
      visibleAt: visibleAtSec,
      notify: true,
      ruleKind: "unfinished_lecture",
      ruleDate: trackId,
      prepState: "pending",
    })
    if (created === null) {
      // The (rule, track) row already existed — the session we just
      // minted is an orphan. Delete it so the history list stays clean
      // (mirrors the main tick loop's rollback).
      await ctx.repos.chatSessions.delete(sessionId).catch(() => undefined)
      return
    }

    // Static-with-title copy: the app is backgrounded and `buildContent`
    // hasn't run, so the body is composed here from the catalog title. A
    // later foreground tick re-arms the same id with the prepped card
    // preview (idempotent on id at the Capacitor layer).
    try {
      await app.notifications.schedule({
        id: notificationIdFor(chatMessageId),
        title: sessionTitle,
        body: ctx.t("notifications.unfinishedLectureBody", { title }),
        at: fireAt.getTime(),
        extra: { chatSessionId: sessionId, chatMessageId },
      })
    } catch (err) {
      console.warn("[proactive/unfinished_lecture] schedule notification failed", err)
    }
  },

  async validate(entry, ctx) {
    const trackId = entry.ruleDate as TrackId
    const track = await ctx.repos.tracks.getById(trackId)
    // Track pulled from the catalog (hide=1) → drop the row.
    if (track === null || track.hidden) return false
    const progress = await ctx.repos.listeningSessions.listRecentTracksWithProgress(RECENT_LIMIT)
    const row = progress.find((r) => r.trackId === trackId)
    // Dropped out of the recent window → the user has listened to a pile
    // of other lectures since; a "come back to this one" nudge is stale.
    // Supersede so the scheduler cancels the alarm.
    if (!row) return false
    // Listened past the completion threshold → finished, nudge is moot.
    const fraction = progressFraction(track, row.positionSec)
    if (fraction !== null && fraction > MAX_PROGRESS) return false
    return true
  },

  async buildContent(entry, ctx) {
    const track = await ctx.repos.tracks.getById(entry.ruleDate as TrackId)
    if (track === null) return null
    const title = localizedTitle(track, ctx.locale)
    const body = ctx.t("chat.proactiveUnfinishedLectureBody", { title })
    const marker = `[action:queue_next_track|id=${ACTION_ID}]`
    return {
      bodyMd: `${body}\n\n${marker}`,
      actions: {
        [ACTION_ID]: {
          kind: "queue_next_track",
          id: ACTION_ID,
          trackId: track.id,
        },
      },
    }
  },
}

registerRule(handler)
