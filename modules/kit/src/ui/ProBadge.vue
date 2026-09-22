<template>
  <span class="pro-badge"
    ><slot>{{ label }}</slot></span
  >
</template>

<script setup lang="ts">
/**
 * A tiny inline "PRO" tag for marking premium features. i18n-agnostic: the text
 * comes from the `label` prop (already-translated) or the default slot.
 * Appearance is token-driven (defaults to the Ionic primary palette).
 */
defineProps<{
  /** Already-translated badge text (kit is i18n-agnostic). Overridden by slot. */
  label?: string
}>()
</script>

<style scoped>
.pro-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: var(--kit-pro-badge-bg, var(--ion-color-primary));
  color: var(--kit-pro-badge-fg, var(--ion-color-primary-contrast));
  vertical-align: middle;
  line-height: 1.3;
}
</style>
