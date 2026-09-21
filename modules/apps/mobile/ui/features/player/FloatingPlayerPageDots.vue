<script setup lang="ts">
defineProps<{
  /** Currently visible page index, 0-based. */
  page: number
  /** Total pages in the carousel. */
  count: number
  hidden: boolean
}>()
</script>

<template>
  <div class="page-dots" :aria-hidden="hidden">
    <span v-for="i in count" :key="i" :class="{ dot: true, active: page === i - 1 }" />
  </div>
</template>

<style scoped>
.page-dots {
  position: absolute;
  top: calc(var(--content-height, 58px) / 2);
  left: 6px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
  z-index: 3;
}

.dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.35);
}

.dot.active {
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.85);
}
</style>
