<template>
  <Badge class="duration-badge" :style="NEUTRAL" :title="title">
    <template #icon><ClockIcon /></template>
    {{ text }}
  </Badge>
</template>

<script setup lang="ts">
import { Badge } from "@kit/ui"
import { ClockIcon } from "@ui/icons/index.js"

defineProps<{
  text: string
  title?: string
}>()

// Neutral look (was SectionBadge default): light fill + medium text.
const NEUTRAL: Record<string, string> = {
  "--kit-badge-bg": "var(--ion-color-light)",
  "--kit-badge-fg": "var(--ion-color-medium)",
}
</script>

<style scoped>
.duration-badge :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
