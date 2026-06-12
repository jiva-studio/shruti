<template>
  <button type="button" class="chip" @click="$emit('pick')">
    <slot />
  </button>
</template>

<script setup lang="ts">
// Shared pill button for a single chat chip. Pure presentation — its list
// wrapper (ChatChips) owns the data, layout, and a11y attrs (role/aria-label
// fall through to the button).
defineEmits<{ pick: [] }>()
</script>

<style scoped>
.chip {
  appearance: none;
  border: 1px dashed rgba(var(--ion-color-primary-rgb), 0.45);
  background: transparent;
  color: var(--ion-text-color);
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.chip:active {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}
</style>
