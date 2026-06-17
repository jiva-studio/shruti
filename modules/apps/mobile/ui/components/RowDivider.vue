<template>
  <div class="row-divider" aria-hidden="true" />
</template>

<script setup lang="ts">
/**
 * A hairline list separator that fades to transparent at both ends (like the
 * chat topic separator). Rendered BETWEEN rows at the list level — not inside a
 * row — so it never gets clipped by an item's swipe wrapper and a list never
 * ends on a trailing line.
 */
</script>

<style scoped>
.row-divider {
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    var(--shruti-divider, rgba(0, 0, 0, 0.07)),
    transparent
  );
  pointer-events: none;
}
</style>
