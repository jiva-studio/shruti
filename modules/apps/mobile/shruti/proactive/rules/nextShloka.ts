import type { LanguageCode, SourceId, TrackId } from "@lib/domain/core.js"
import type { Source } from "@lib/domain/source.js"
import { formatReference } from "@lib/domain/services/references.js"
import { registerRule } from "../registry.js"
import type { ProactiveRuleHandler } from "../types.js"

/** Single action id per message — exactly one card. */
const ACTION_ID = "main"
/** How many recent listening entries to inspect for a reference-bearing
 *  track. The heatmap uses 10; reusing that horizon keeps the rule's
 *  "what counts as recent" consistent with the rest of the app. */
const RECENT_LIMIT = 10

/**
 * Nudge the user to listen to the next verse in a series.
 *
 * Trigger flow:
 * 1. Walk the user's last 10 listening sessions newest-first.
 * 2. Pick the first track that carries a scripture reference.
 * 3. Increment the last numeric token (handles ranges like `13-14` by
 *    taking the upper bound).
 * 4. Look up a catalog track with that exact (sourceId, tokens). If
 *    found and not already in the recent set, emit a DetectResult.
 *
 * `ruleDate` is set to the next track's id so `UNIQUE(rule_kind, rule_date)`
 * prevents the same shloka from being suggested twice across the rule's
 * retention window — even after the 24h cooldown expires.
 *
 * Chapter / canto boundaries are intentionally NOT handled — we don't
 * know how long a chapter is without per-source metadata. The lookup
 * simply returns null and the rule stays silent.
 */
const handler: ProactiveRuleHandler = {
  id: "next_shloka",

  async detect(ctx) {
    const repos = ctx.repos
    const recent = await repos.listeningSessions.listRecentTracksWithProgress(RECENT_LIMIT)
    if (recent.length === 0) return []

    const recentIds = new Set(recent.map((r) => r.trackId))
    const tracksById = await repos.tracks.getByIds(recent.map((r) => r.trackId))

    for (const r of recent) {
      const track = tracksById.get(r.trackId)
      if (!track || track.references.length === 0) continue
      const lastRef = track.references[track.references.length - 1]
      const nextTokens = computeNextTokens(lastRef.tokens)
      if (nextTokens === null) continue
      const nextTrack = await repos.tracks.findByReference(lastRef.sourceId, nextTokens)
      if (nextTrack === null) continue
      // Skip if the "next" verse is already in the user's recent
      // listening — that means they've moved past it and the nudge
      // would be noise.
      if (recentIds.has(nextTrack.id)) continue
      return [
        {
          // The next track's id doubles as the dedup key so the rule
          // never suggests the same shloka twice.
          ruleDate: nextTrack.id,
          // Silent suggestion: visible immediately (no future gate),
          // no OS push — the chat badge is enough.
          visibleAt: null,
          notify: false,
          sessionTitleOverride: ctx.t("chat.proactiveSessionTitleNextShloka"),
          templateContext: {},
        },
      ]
    }
    return []
  },

  async validate(entry, ctx) {
    // Verify the suggested track still exists. catalog.publish can drop
    // tracks (hide=1) — in that case we supersede the row rather than
    // ship a broken card.
    const track = await ctx.repos.tracks.getById(entry.ruleDate as TrackId)
    return track !== null
  },

  async buildContent(entry, ctx) {
    const track = await ctx.repos.tracks.getById(entry.ruleDate as TrackId)
    if (track === null || track.references.length === 0) return null
    const ref = track.references[track.references.length - 1]
    const lang: LanguageCode = ctx.locale.startsWith("en") ? "en" : "ru"
    const allSources = await ctx.repos.sources.listAll()
    const sourcesById = new Map<SourceId, Source>(allSources.map((s) => [s.id, s]))
    const refLabel = formatReference(ref, sourcesById, lang)
    const variant = track.variants.find((v) => v.language === lang) ?? track.variants[0] ?? null
    const title = variant?.title ?? ""
    const body = ctx.t("chat.proactiveNextShlokaBody", {
      ref: refLabel,
      title,
    })
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

/**
 * Bump the last numeric token by one. Returns `null` when the token
 * isn't numeric so the rule fails closed (better silent than a wrong
 * suggestion).
 *
 * Ranges like `"13-14"` become `"15"` — we take the upper bound and
 * step from there.
 */
export function computeNextTokens(tokens: readonly string[]): readonly string[] | null {
  if (tokens.length === 0) return null
  const last = tokens[tokens.length - 1]
  const upperBound = last.includes("-") ? last.split("-").pop()! : last
  const n = Number.parseInt(upperBound, 10)
  if (!Number.isFinite(n) || String(n) !== upperBound) return null
  return [...tokens.slice(0, -1), String(n + 1)]
}

registerRule(handler)
