<template>
  <Badge
    v-if="value > 0"
    class="completed-badge"
    :style="NEUTRAL"
    :title="t('activity.completedLectures')"
  >
    <template #icon><IconRosetteDiscountCheckFilled /></template>
    {{ value }}
  </Badge>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Badge } from "@kit/ui"
import { IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()

const { t } = useI18n()

// Neutral look (was SectionBadge default): light fill + medium text.
const NEUTRAL: Record<string, string> = {
  "--kit-badge-bg": "var(--ion-color-light)",
  "--kit-badge-fg": "var(--ion-color-medium)",
}
</script>

<style scoped>
.completed-badge :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
