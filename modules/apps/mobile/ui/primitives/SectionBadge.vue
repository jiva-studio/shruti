<template>
  <span :class="['section-badge', { 'section-badge--accent': accent }]" :title="title">
    <slot />
  </span>
</template>

<script setup lang="ts">
defineProps<{
  accent?: boolean
  title?: string
}>()
</script>

<style scoped>
.section-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  background: var(--ion-color-light, rgba(0, 0, 0, 0.06));
  color: var(--ion-color-medium, currentColor);
  white-space: nowrap;
  line-height: 1.4;
}

.section-badge--accent {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.section-badge :slotted(:where(svg, img, i)) {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
