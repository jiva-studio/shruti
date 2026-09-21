<script setup lang="ts">
import { SectionHeader } from "@ui/primitives/index.js"
import { DurationBadge } from "@ui/components/badges/index.js"
import { PlaylistCountBadge } from "@ui/features/playlist/index.js"
import { useDurationFormatter } from "@shruti/composables/useDurationFormatter.js"

defineProps<{ count: number; totalSeconds: number }>()

const formatDuration = useDurationFormatter()
</script>

<template>
  <SectionHeader :title="$t('home.upNext')">
    <PlaylistCountBadge :value="count" />
    <DurationBadge v-if="totalSeconds > 0" :text="formatDuration(totalSeconds)" />
  </SectionHeader>
</template>
