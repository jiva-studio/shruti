<template>
  <div class="kit-icon-chip" :class="{ 'kit-icon-chip--danger': danger }">
    <slot />
  </div>
</template>

<script setup lang="ts">
/**
 * A small rounded square that frames a single icon (passed via the default
 * slot) — the leading affordance used by settings rows, list items, etc.
 * Generic: no icon set is imported, the caller supplies the icon. Appearance is
 * token-driven; `danger` switches to the danger palette.
 */
defineProps<{
  danger?: boolean
}>()
</script>

<style scoped>
.kit-icon-chip {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  padding: 6px 6px;
  border-radius: 5px;
  background-color: var(--kit-icon-chip-bg, var(--ion-color-light));
  color: var(--kit-icon-chip-fg, var(--ion-color-medium));
}

.kit-icon-chip--danger {
  background-color: var(--kit-icon-chip-danger-bg, rgba(var(--ion-color-danger-rgb), 0.12));
  color: var(--kit-icon-chip-danger-fg, var(--ion-color-danger));
}
</style>
