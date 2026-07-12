<template>
  <div class="digest-card">
    <div class="digest-title">{{ t("chat.weeklyDigestTitle") }}</div>

    <!-- 7-day listening chart: one rounded bar per day, height ∝ time. -->
    <div class="digest-chart" :aria-label="t('chat.weeklyDigestTitle')">
      <div v-for="(day, i) in chartDays" :key="i" class="digest-chart-col">
        <div class="digest-chart-track">
          <div
            class="digest-chart-bar"
            :class="{ 'digest-chart-bar--today': day.isToday }"
            :style="{ height: barHeight(day.listenedSeconds) }"
          />
        </div>
        <div class="digest-chart-label">{{ day.label }}</div>
      </div>
    </div>

    <!-- Summary pills: total time / completed / streak. -->
    <div class="digest-summary">
      <DurationBadge
        v-if="totalListenedSeconds > 0"
        :text="formatDuration(totalListenedSeconds)"
        :title="t('chat.weeklyDigestTotalTime')"
      />
      <ActivityStatBadge
        :value="completedCount"
        variant="neutral"
        :label="t('activity.completedLectures')"
      >
        <template #icon><IconRosetteDiscountCheckFilled /></template>
      </ActivityStatBadge>
      <ActivityStatBadge :value="currentStreak" variant="accent" :label="t('activity.streak')">
        <template #icon><FlameIcon /></template>
      </ActivityStatBadge>
    </div>

    <!-- Lectures listened this week. -->
    <div v-if="visibleLectures.length > 0" class="digest-list">
      <div v-for="lecture in visibleLectures" :key="lecture.trackId" class="digest-row">
        <span class="digest-row-title">{{ lecture.title }}</span>
        <span class="digest-row-duration">{{ formatDuration(lecture.listenedSeconds) }}</span>
      </div>
      <div v-if="moreCount > 0" class="digest-more">
        {{ t("chat.weeklyDigestMore", { count: moreCount }) }}
      </div>
    </div>
    <div v-else-if="loaded" class="digest-empty">{{ t("chat.weeklyDigestEmpty") }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDurationFormatter } from "@lectorium/composables/useDurationFormatter.js"
import { getActivityOverview } from "@usecases/activity/getActivityOverview.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import type { TrackId } from "@lib/domain/core.js"
import { DurationBadge } from "@ui/components/badges/index.js"
import { ActivityStatBadge } from "@ui/features/activity/index.js"
import { FlameIcon, IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"

const props = defineProps<{
  fromMs: number
  toMs: number
}>()

const { t } = useI18n()
const app = useLectorium()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
const formatDuration = useDurationFormatter()

/** How many lectures to show before folding the rest into "+N more". */
const MAX_LECTURES = 8

interface LectureRow {
  readonly trackId: string
  readonly title: string
  readonly listenedSeconds: number
}

interface ChartDay {
  readonly label: string
  readonly listenedSeconds: number
  readonly isToday: boolean
}

const loaded = ref(false)
const totalListenedSeconds = ref(0)
const completedCount = ref(0)
const currentStreak = ref(0)
const lectures = ref<readonly LectureRow[]>([])
const chartDays = ref<readonly ChartDay[]>([])

const visibleLectures = computed(() => lectures.value.slice(0, MAX_LECTURES))
const moreCount = computed(() => Math.max(0, lectures.value.length - MAX_LECTURES))

/** Tallest bar in the window → 100%; everything else scales against it.
 *  Keeps a small floor so a day with any listening is visibly non-zero. */
const peakSeconds = computed(() =>
  chartDays.value.reduce((max, d) => Math.max(max, d.listenedSeconds), 0)
)

function barHeight(seconds: number): string {
  if (seconds <= 0 || peakSeconds.value <= 0) return "0%"
  const pct = (seconds / peakSeconds.value) * 100
  return `${Math.max(8, pct)}%`
}

function isoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

async function load(): Promise<void> {
  try {
    const repos = app.repositories()
    const now = Date.now()

    const [dailyTotals, ranged, overview] = await Promise.all([
      repos.listeningSessions.getDailyTotalsByDayOffset(props.fromMs, props.toMs),
      repos.listeningSessions.getTracksListenedInRange(props.fromMs, props.toMs),
      getActivityOverview(
        { fromMs: props.fromMs, toMs: props.toMs, nowMs: now, totalDays: 7 },
        {
          listeningSessions: repos.listeningSessions,
          playlistItems: repos.playlistItems,
          tracks: repos.tracks,
        }
      ),
    ])

    // Streak is a rolling property of the whole history; completed-count
    // and the week's total come from the windowed overview / daily totals.
    currentStreak.value = overview.currentStreak
    completedCount.value = overview.completedCount
    totalListenedSeconds.value = dailyTotals.reduce((acc, d) => acc + d.listenedSeconds, 0)

    // Build a fixed 7-day chart from `fromMs`, filling gaps with zero so
    // the bar row always has seven columns regardless of which days had
    // any listening. Bars are keyed by day offset from `fromMs` — the same
    // anchor the totals are bucketed against — so they never depend on a
    // calendar-date string lining up across the SQLite/JS timezone boundary.
    const byOffset = new Map(dailyTotals.map((d) => [d.dayOffset, d.listenedSeconds]))
    const todayIso = isoDate(new Date(now))
    const days: ChartDay[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(props.fromMs + i * 86_400_000)
      days.push({
        label: d.toLocaleDateString(appLanguage.value, { weekday: "narrow" }),
        listenedSeconds: byOffset.get(i) ?? 0,
        isToday: isoDate(d) === todayIso,
      })
    }
    chartDays.value = days

    // Resolve titles in one batched read; pick the user's locale variant.
    const ids = ranged.map((r) => r.trackId)
    const tracksById = await repos.tracks.getByIds(ids)
    lectures.value = ranged.map((r) => {
      const track = tracksById.get(r.trackId as TrackId)
      const contentLang = track
        ? preferredContentLanguage(track, libraryLanguages.value, appLanguage.value)
        : undefined
      return {
        trackId: r.trackId,
        title: resolveTrackTitle(track, contentLang ?? appLanguage.value) ?? "",
        listenedSeconds: r.listenedSeconds,
      }
    })
  } catch (err) {
    console.warn("[weekly-digest-card] load failed", err)
  } finally {
    loaded.value = true
  }
}

onMounted(() => {
  void load()
})
</script>

<style scoped>
/* Rounded, borderless card tinted with the primary color token so it
 * reads as a panel in both light and dark themes (the rgba alpha keeps
 * it subtle against either background). */
.digest-card {
  margin: 10px 0;
  padding: 14px;
  border-radius: 16px;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
  color: var(--ion-text-color);
}

.digest-title {
  font-weight: 700;
  font-size: 15px;
  margin-bottom: 12px;
  color: var(--ion-color-primary);
}

/* Chart — seven equal columns, bars grow from the bottom. */
.digest-chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 84px;
}
.digest-chart-col {
  flex: 1 1 0;
  /* Fill the chart's fixed height so the track below is a definite box —
   * without this the column shrinks to its label and the bars' percentage
   * heights resolve against ~0, collapsing every bar to the 2px floor. */
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.digest-chart-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.digest-chart-bar {
  width: 60%;
  min-height: 2px;
  border-radius: 6px;
  background: rgba(var(--ion-color-primary-rgb), 0.35);
  transition: height 0.2s ease;
}
.digest-chart-bar--today {
  background: var(--ion-color-primary);
}
.digest-chart-label {
  margin-top: 4px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}

/* Summary pills row. */
.digest-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0;
}

/* Lecture list. */
.digest-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.digest-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.digest-row-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
}
.digest-row-duration {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--ion-color-medium);
  font-variant-numeric: tabular-nums;
}
.digest-more {
  font-size: 12px;
  color: var(--ion-color-medium);
  margin-top: 2px;
}
.digest-empty {
  font-size: 13px;
  color: var(--ion-color-medium);
}
</style>
