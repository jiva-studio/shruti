<script setup lang="ts">
import { SectionHeader } from "@ui/primitives/index.js"
import { DurationBadge } from "@ui/components/badges/index.js"
import { FlameIcon, IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"
import ActivitySection from "./ActivitySection.vue"
import ActivityStatBadge from "./ActivityStatBadge.vue"
import type { ActivityHeatmapDay } from "./ActivityHeatmap.types.js"

/** `totalListenedText` is pre-formatted: the app layer owns seconds→label. */
defineProps<{
  title: string
  streak: number
  streakLabel: string
  completed: number
  completedLabel: string
  totalListenedText: string
  totalListenedLabel: string
  days: readonly ActivityHeatmapDay[]
}>()
</script>

<template>
  <SectionHeader :title="title">
    <ActivityStatBadge :value="streak" variant="accent" :label="streakLabel">
      <template #icon><FlameIcon /></template>
    </ActivityStatBadge>
    <ActivityStatBadge :value="completed" variant="neutral" :label="completedLabel">
      <template #icon><IconRosetteDiscountCheckFilled /></template>
    </ActivityStatBadge>
    <DurationBadge v-if="totalListenedText" :text="totalListenedText" :title="totalListenedLabel" />
  </SectionHeader>
  <ActivitySection :days="days" />
</template>
