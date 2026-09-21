<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"
import { getActivityOverview } from "@usecases/activity/getActivityOverview.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import type { TrackId } from "@lib/domain/core.js"
import { DurationBadge } from "@ui/components/badges/index.js"
import { ActivityStatBadge } from "@ui/features/activity/index.js"
import { FlameIcon, IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"
import WeeklyDigestChart from "./WeeklyDigestChart.vue"
import { buildChartDays, type ChartDay } from "../weeklyDigest.js"

const props = defineProps<{
  fromMs: number
  toMs: number
}>()

const { t } = useI18n()
const app = useShruti()
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

const loaded = ref(false)
const totalListenedSeconds = ref(0)
const completedCount = ref(0)
const currentStreak = ref(0)
const lectures = ref<readonly LectureRow[]>([])
const chartDays = ref<readonly ChartDay[]>([])

const visibleLectures = computed(() => lectures.value.slice(0, MAX_LECTURES))
const moreCount = computed(() => Math.max(0, lectures.value.length - MAX_LECTURES))

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

    // Streak is a rolling property of the whole history; the count and the
    // week's total come from the window.
    currentStreak.value = overview.currentStreak
    completedCount.value = overview.completedCount
    totalListenedSeconds.value = dailyTotals.reduce((acc, d) => acc + d.listenedSeconds, 0)

    chartDays.value = buildChartDays(dailyTotals, props.fromMs, now, appLanguage.value)

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

<template>
  <div class="digest-card">
    <div class="digest-title">{{ t("chat.weeklyDigestTitle") }}</div>

    <WeeklyDigestChart :days="chartDays" :label="t('chat.weeklyDigestTitle')" />

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

<style scoped>
/* Tinted with the primary token so it reads as a panel in either theme. */
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
