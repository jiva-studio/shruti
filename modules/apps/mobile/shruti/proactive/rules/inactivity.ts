import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { notificationIdFor } from "../hash.js"
import { NOTIFICATION_PRIORITY, type NotificationCandidate } from "../notificationPlanner.js"
import { resolveSessionId } from "../sessions.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const DAY_MS = 86_400_000

/**
 * Escalating re-engagement ladder.
 *
 * When the app goes to background we (re)schedule a series of local
 * notifications at 3 / 7 / 14 / 30 / 60 days of inactivity; whichever
 * one the user doesn't return before fires. The copy escalates from a
 * gentle nudge to a final "it's been a long while".
 *
 * All stages deep-link to ONE persistent "come back" chat session — we
 * never mint a session per stage. The row is created once and re-armed
 * (via `repo.rearm`) on each subsequent background, so its `visible_at`
 * always tracks the user's latest last-activity moment and history never
 * accumulates a pile of inactivity sessions.
 *
 * Returning to the app runs `validate` (foreground-only) which cancels
 * the pending stage alarms — the absence is broken — and the next
 * `onAppPause` re-anchors the whole ladder. Content is static (no LLM),
 * so the session is `ready` the instant it's created and never opens
 * blank when a stage notification is tapped.
 */
const STAGE_DAYS = [3, 7, 14, 30, 60] as const

/** Stable dedup key — exactly one inactivity row ever exists; we re-arm
 *  it instead of minting a fresh row (and chat session) per absence. */
const RULE_DATE = "ladder"

/** i18n key for each stage's notification body. */
export const STAGE_BODY_KEY: Record<number, string> = {
  3: "notifications.proactiveInactivityBody3",
  7: "notifications.proactiveInactivityBody7",
  14: "notifications.proactiveInactivityBody14",
  30: "notifications.proactiveInactivityBody30",
  60: "notifications.proactiveInactivityBody60",
}

/** When re-arming, skip if the row is already anchored within an hour of
 *  the new target — avoids rescheduling five alarms on every rapid
 *  background/foreground flip. */
const REARM_EPSILON_SEC = 3600

function stageNotificationId(chatMessageId: string, day: number): number {
  return notificationIdFor(`${chatMessageId}#inactivity-${day}`)
}

const handler: ProactiveRuleHandler = {
  id: "inactivity",

  async detect() {
    // No foreground detection — a tick only runs while the user is here,
    // so there's never "inactivity to nudge about". The ladder is armed
    // from `onAppPause` below.
    return []
  },

  async onAppPause(ctx) {
    const repo = ctx.repos.proactiveState
    const sessions = ctx.repos.chatSessions
    const firstStageSec = Math.floor((ctx.nowMs + STAGE_DAYS[0] * DAY_MS) / 1000)

    const existing = await repo.findByRuleAndDate("inactivity", RULE_DATE)

    let chatMessageId: string
    let sessionId: ChatSessionId

    if (existing !== null) {
      // Already anchored within the last hour for this same target — the
      // ladder stands, don't re-anchor (the planner already holds the
      // matching alarms).
      if (
        existing.visibleAt !== null &&
        Math.abs(existing.visibleAt - firstStageSec) < REARM_EPSILON_SEC
      ) {
        return
      }
      chatMessageId = existing.chatMessageId
      sessionId = existing.sessionId
      // Re-anchor the row to this background moment. The planner reads
      // `visible_at` to derive the five stage fire times and reschedules.
      await repo.rearm(existing.chatMessageId, firstStageSec)
    } else {
      sessionId = await resolveSessionId(
        {
          config: {
            id: "inactivity",
            enabled: true,
            mode: "pre_baked",
            prep_window_hours: 0,
            refresh_if_older_than_hours: 24,
            session_strategy: "new_session",
            cooldown_hours: 0,
          },
          handler,
        },
        {
          ruleDate: RULE_DATE,
          visibleAt: firstStageSec,
          notify: false,
          sessionTitleOverride: ctx.t("chat.proactiveSessionTitleInactivity"),
          templateContext: {},
        },
        ctx.nowMs,
        sessions
      )
      chatMessageId = randomId()
      const created = await repo.create({
        chatMessageId: chatMessageId as ChatMessageId,
        sessionId,
        role: "assistant",
        content: ctx.t("chat.proactiveInactivityWelcomeBody"),
        createdAt: ctx.nowMs,
        visibleAt: firstStageSec,
        // The rule owns notification scheduling (one alarm per stage), so
        // keep the generic scheduler's notify path out of it — otherwise
        // it would arm a sixth alarm at `visible_at`. Visibility is still
        // driven by `visible_at`; `notify` only gates the auto-push.
        notify: false,
        ruleKind: "inactivity",
        ruleDate: RULE_DATE,
        prepState: "ready",
      })
      if (created === null) {
        // Lost the create race — drop the orphan session we just minted.
        await sessions.delete(sessionId).catch(() => undefined)
        return
      }
    }
    // The five stage alarms are no longer scheduled here. The planner
    // (run right after `onAppPause` from the background path) reads this
    // row via `collectNotifications` and arbitrates the ladder against
    // the day's higher-priority pushes — one per local day.
  },

  collectNotifications(entry, ctx, phase): NotificationCandidate[] {
    // Foreground = the user is here, the absence is broken — no ladder.
    // The planner cancels any armed stage alarms because none of these
    // ids appear in the desired set.
    if (phase === "foreground") return []
    if (entry.visibleAt === null) return []
    // `visible_at` is anchored at (background moment + 3 days), i.e. the
    // first stage. Recover the background moment to lay out all stages.
    const anchor = entry.visibleAt * 1000 - STAGE_DAYS[0] * DAY_MS
    return STAGE_DAYS.map((day) => ({
      id: stageNotificationId(entry.chatMessageId, day),
      fireAtMs: anchor + day * DAY_MS,
      priority: NOTIFICATION_PRIORITY.inactivity,
      kind: "inactivity",
      title: ctx.t("app.name"),
      body: ctx.t(STAGE_BODY_KEY[day]),
      extra: { chatSessionId: entry.sessionId, chatMessageId: entry.chatMessageId },
    }))
  },

  async validate() {
    // `validate` runs from a foreground tick → the user is here, so the
    // absence is broken. Keep the row (it's the single reused session);
    // the planner cancels the stage alarms this pass because the
    // foreground `collectNotifications` returns `[]`. The next
    // `onAppPause` re-anchors the ladder to the new last-activity moment.
    return true
  },

  async buildContent(entry, ctx) {
    // Deterministic, no LLM. Returned here too (not just at create time)
    // so a stale-refresh tick rewrites the same copy instead of blanking
    // the row.
    void entry
    return { bodyMd: ctx.t("chat.proactiveInactivityWelcomeBody") }
  },
}

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

registerRule(handler)
