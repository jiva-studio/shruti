<template>
  <Badge v-if="value > 0" class="streak-badge" :style="ACCENT" :title="t('activity.streak')">
    <template #icon><FlameIcon /></template>
    {{ value }}
  </Badge>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Badge } from "@kit/ui"
import { FlameIcon } from "@ui/icons/index.js"

defineProps<{
  value: number
}>()

const { t } = useI18n()

// Solid accent look (was SectionBadge `accent`): filled primary + contrast text.
const ACCENT: Record<string, string> = {
  "--kit-badge-bg": "var(--ion-color-primary)",
  "--kit-badge-fg": "var(--ion-color-primary-contrast)",
}
</script>

<style scoped>
.streak-badge :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
