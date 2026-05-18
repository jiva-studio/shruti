import { useShruti } from "@shruti/shruti.js"
import { runProactiveTurn } from "../proactiveChat.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const INACTIVITY_DAYS = 7
const DAY_MS = 86_400_000

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Re-engagement nudge after `INACTIVITY_DAYS` of no opens. The
 * speculative-prep contract is `onAppPause`: when the app suspends we
 * speculatively schedule the LocalNotification for 7 days from now.
 * On every resume the validator re-checks; if the user came back we
 * mark the row `superseded` and cancel the alarm.
 *
 * The scheduler's main `tick()` doesn't drive detection for this rule
 * (we'd never fire while the user is open), but it does drive
 * `validate` + `buildContent` for any pending row.
 */
const handler: ProactiveRuleHandler = {
  id: "inactivity",

  async detect(_ctx) {
    // No foreground detection — only `onAppPause` (below) emits new
    // instances. Foreground ticks would always see "user is here, no
    // inactivity to nudge about".
    return []
  },

  async onAppPause(ctx) {
    const app = useShruti()
    const repo = app.repositories().proactiveState
    const recent = await repo.listRecentByRule("inactivity", 1)
    const cooldownMs = 14 * DAY_MS
    if (recent.length > 0 && ctx.nowMs - recent[0].createdAt < cooldownMs) return

    const fireAt = new Date(ctx.nowMs + INACTIVITY_DAYS * DAY_MS)
    const ruleDate = formatYmd(fireAt)
    const existing = await repo.findByRuleAndDate("inactivity", ruleDate)
    if (existing !== null) return

    const sessions = app.repositories().chatSessions
    const { resolveSessionId } = await import("@shruti/proactive/sessions.js")
    const sessionId = await resolveSessionId(
      {
        config: {
          id: "inactivity",
          enabled: true,
          mode: "pre_baked",
          prep_window_hours: 0,
          refresh_if_older_than_hours: 24,
          session_strategy: "new_session",
          cooldown_hours: 336,
        },
        handler,
      },
      {
        ruleDate,
        visibleOn: ruleDate,
        notifyAt: Math.floor(fireAt.getTime() / 1000),
        templateContext: {},
      },
      ctx.nowMs,
      sessions
    )
    // Use the same id-generator the scheduler uses so notification
    // hashes line up if we later need to cancel.
    const chatMessageId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
    await repo.create({
      chatMessageId: chatMessageId as never,
      sessionId,
      role: "assistant",
      content: "",
      createdAt: ctx.nowMs,
      visibleOn: ruleDate,
      notifyAt: Math.floor(fireAt.getTime() / 1000),
      ruleKind: "inactivity",
      ruleDate,
      prepState: "pending",
    })
  },

  async validate(entry, ctx) {
    // If the user came back BEFORE the speculative fire, the entry is
    // moot — kill it and let the scheduler skip the LocalNotification.
    const fireAtMs = entry.notifyAt !== null ? entry.notifyAt * 1000 : 0
    if (ctx.nowMs < fireAtMs) {
      // We're still in foreground (this fn only runs from a tick) —
      // by definition the user came back, supersede.
      return false
    }
    return true
  },

  async buildContent(_entry, ctx) {
    const app = useShruti()
    const repos = app.repositories()
    const recent = await repos.listeningSessions.listRecentTracksWithProgress(10)
    const trackIds = recent.map((r) => r.trackId)
    const tracksById = trackIds.length > 0
      ? await repos.tracks.getByIds(trackIds)
      : new Map()

    const lastTopicTags: string[] = []
    const lastAuthors: string[] = []
    for (const r of recent) {
      const track = tracksById.get(r.trackId)
      if (!track) continue
      for (const tag of track.tagIds.slice(0, 3)) {
        if (!lastTopicTags.includes(tag)) lastTopicTags.push(tag)
      }
      if (track.authorId && !lastAuthors.includes(track.authorId)) {
        lastAuthors.push(track.authorId)
      }
      if (lastTopicTags.length >= 5 && lastAuthors.length >= 3) break
    }

    const ruleContext = {
      days_away: INACTIVITY_DAYS,
      last_topic_tags: lastTopicTags,
      last_authors: lastAuthors,
      last_completed_track_id: recent.length > 0 ? recent[0].trackId : null,
    }

    return runProactiveTurn(
      {
        ruleKind: "inactivity",
        ruleDate: _entry.ruleDate,
        ruleContext,
      },
      ctx.locale.startsWith("en") ? "en" : "ru"
    )
  },
}

registerRule(handler)
