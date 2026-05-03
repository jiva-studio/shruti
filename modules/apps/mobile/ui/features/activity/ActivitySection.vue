<template>
  <div class="activity-card">
    <ActivityHeatmap :days="days" />
  </div>
</template>

<script setup lang="ts">
import ActivityHeatmap from "./ActivityHeatmap.vue"
import type { ActivityHeatmapDay } from "./ActivityHeatmap.types.js"

defineProps<{
  days: readonly ActivityHeatmapDay[]
}>()
</script>

<style scoped>
.activity-card {
  padding: 12px 16px;
}
</style>
