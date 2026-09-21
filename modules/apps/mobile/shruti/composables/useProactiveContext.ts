import { useI18n } from "vue-i18n"
import { getActivityOverview } from "@usecases/activity/getActivityOverview.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { localDate, localTime } from "@shruti/composables/proactiveClock.js"
import { useSearchFiltersStore } from "@shruti/stores/useSearchFiltersStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import type { ProactiveContext } from "@shruti/proactive/types.js"

/** Trailing window for the listening-stats predicates. Matches what the
 *  activity heatmap uses elsewhere. */
const ACTIVITY_WINDOW_DAYS = 224

/**
 * Snapshot of everything a rule's predicates and content builders read:
 * wall clock, locale, notification permission, subscription and the trailing
 * listening stats. Repos live on it too, so rule handlers never call
 * `useShruti()` themselves and stay framework-free.
 */
export function useProactiveContext(): () => Promise<ProactiveContext> {
  const app = useShruti()
  const language = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const filtersStore = useSearchFiltersStore()
  const purchases = usePurchasesStore()
  const { t } = useI18n()
  // Stamped the first time the scheduler runs — the device never sees a fresh
  // install on the same DB twice. `days_since_install_at_least` reads it.
  const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)
  const dailyEnabled = useConfig<boolean>("settings.notificationsEnabled", false)

  async function gatherContext(): Promise<ProactiveContext> {
    const nowMs = Date.now()
    const now = new Date(nowMs)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const permission = await app.notifications.checkPermission().catch(() => "unknown" as const)

    // Activity stats — best-effort. If repos are not ready yet (cold
    // boot, content DB still downloading) we fall back to zeros, which
    // makes most eligibility predicates fail and effectively suspends
    // the scheduler until the next tick.
    let totalListenedSeconds = 0
    let currentStreak = 0
    let completedTracks = 0
    try {
      const repos = app.repositories()
      const fromMs = nowMs - ACTIVITY_WINDOW_DAYS * 86_400_000
      const toMs = nowMs + 86_400_000
      const overview = await getActivityOverview(
        { fromMs, toMs, nowMs, totalDays: ACTIVITY_WINDOW_DAYS },
        {
          listeningSessions: repos.listeningSessions,
          playlistItems: repos.playlistItems,
          tracks: repos.tracks,
        }
      )
      totalListenedSeconds = overview.totalListenedSeconds
      currentStreak = overview.currentStreak
      completedTracks = overview.completedCount
    } catch (err) {
      // Repos not ready or query failed — leave zeros.
      if (typeof console !== "undefined") {
        console.debug("[proactive] activity overview unavailable:", err)
      }
    }

    if (firstSeenAt.value === null) {
      firstSeenAt.value = nowMs
    }

    // Ensure the library-language facet is hydrated before we snapshot it,
    // so a cold-start tick doesn't see an empty set (which would drop the
    // language filter and let the daily-wisdom rule deliver any language).
    await filtersStore.load().catch(() => undefined)

    return {
      nowMs,
      localDate: localDate(now),
      localTime: localTime(now),
      timezone,
      locale: language.value,
      hasNotificationsPermission: permission === "granted",
      notificationsEnabled: dailyEnabled.value,
      isSubscribed: purchases.isSubscribed,
      totalListenedSeconds,
      currentStreak,
      completedTracks,
      firstSeenAtMs: firstSeenAt.value,
      t: (key: string, params?: Record<string, unknown>) => (params ? t(key, params) : t(key)),
      // Repos + proactiveChat live on ctx so rule handlers never call
      // `useShruti()` themselves — they stay framework-free and
      // testable. `app.repositories()` is safe to call here because
      // proactiveRepo() already gated us on both DBs being open at the
      // top of tick().
      repos: app.repositories(),
      proactiveChat: app.proactiveChat,
      libraryLanguages: libraryLanguages.value,
    }
  }

  return gatherContext
}
