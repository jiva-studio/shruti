<template>
  <Badge v-if="value > 0" class="activity-stat-badge" :style="STYLES[variant]" :title="label">
    <template #icon><slot name="icon" /></template>
    {{ value }}
  </Badge>
</template>

<script setup lang="ts">
import { Badge } from "@kit/ui"

defineProps<{
  value: number
  variant: "accent" | "neutral"
  label: string
}>()

const STYLES: Record<"accent" | "neutral", Record<string, string>> = {
  // Solid accent look: filled primary + contrast text.
  accent: {
    "--kit-badge-bg": "var(--ion-color-primary)",
    "--kit-badge-fg": "var(--ion-color-primary-contrast)",
  },
  // Neutral look: light fill + medium text.
  neutral: {
    "--kit-badge-bg": "var(--ion-color-light)",
    "--kit-badge-fg": "var(--ion-color-medium)",
  },
}
</script>

<style scoped>
.activity-stat-badge :deep(svg) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
