<template>
  <Badge v-if="value > 0" class="playlist-count-badge" :style="NEUTRAL">
    <template #icon><HeadphonesIcon /></template>
    {{ value }}
  </Badge>
</template>

<script setup lang="ts">
import { Badge } from "@kit/ui"
import { HeadphonesIcon } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()

// Neutral look (was SectionBadge default): light fill + medium text.
const NEUTRAL: Record<string, string> = {
  "--kit-badge-bg": "var(--ion-color-light)",
  "--kit-badge-fg": "var(--ion-color-medium)",
}
</script>

<style scoped>
.playlist-count-badge :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
