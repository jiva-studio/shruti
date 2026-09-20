<template>
  <span class="kit-badge">
    <span v-if="$slots.icon" class="kit-badge-icon"><slot name="icon" /></span>
    <span class="kit-badge-value"><slot /></span>
  </span>
</template>

<script setup lang="ts">
// Structure only — appearance is 100% CSS-token-driven. There are no
// appearance props: the only thing that differs between a "solid" and a "soft"
// badge is the background colour (and its opacity) and the text colour, so the
// host sets `--kit-badge-bg` / `--kit-badge-fg` (per theme + light/dark, and
// per-instance via a modifier class if it wants accent vs neutral).
</script>

<style scoped>
.kit-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 0.8em;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  background: var(--kit-badge-bg, transparent);
  color: var(--kit-badge-fg, var(--ion-color-medium));
}

.kit-badge-icon {
  display: inline-flex;
  align-items: center;
}

.kit-badge-value {
  line-height: 1;
}
</style>
