<template>
  <div class="safe-area-header" />
</template>

<script setup lang="ts">
/**
 * A fixed, top-anchored gradient that fades the system safe-area inset (status
 * bar / notch region) into transparency so scrolling content slides under it
 * cleanly. Generic and i18n/router-free.
 *
 * The fade colour is the host background, supplied via the `--kit-fade-bg-rgb`
 * token as a bare `r, g, b` triple (no `rgb()` wrapper). `@kit/theme/base.css`
 * ships a neutral default; the consuming app overrides it with its own
 * background rgb (per theme + light/dark).
 */
</script>

<style scoped>
.safe-area-header {
  position: fixed;
  left: 0px;
  right: 0px;
  top: 0px;
  height: var(--ion-safe-area-top);
  background: linear-gradient(
    to bottom,
    rgba(var(--kit-fade-bg-rgb), 1) 0%,
    rgba(var(--kit-fade-bg-rgb), 0.8) 35%,
    rgba(var(--kit-fade-bg-rgb), 0) 100%
  );
  z-index: 1;
  pointer-events: none;
}
</style>
