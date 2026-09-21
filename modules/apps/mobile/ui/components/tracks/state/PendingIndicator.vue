<script lang="ts" setup>
/**
 * The tap has landed but nothing is known yet — no progress to show, only
 * "we heard you". Same 24×24 box as the icon and radial indicators so the
 * column doesn't jitter when the real state arrives, and the same slow
 * sweep the tile covers use while their art is on its way.
 *
 * Carries the same `track-state` testid as the icon indicator so a spec
 * that waits for a settled state finds an element reporting "pending"
 * rather than nothing at all while the claim is held.
 */
</script>

<template>
  <span class="pending" aria-hidden="true" data-testid="track-state" data-state="pending" />
</template>

<style scoped>
.pending {
  display: inline-block;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: linear-gradient(
    100deg,
    var(--ion-color-light, #f4f5f8) 30%,
    var(--ion-color-light-shade, #e6e7e9) 50%,
    var(--ion-color-light, #f4f5f8) 70%
  );
  background-size: 300% 100%;
  animation: tile-shimmer 1.4s ease-in-out infinite;
}

@keyframes tile-shimmer {
  from {
    background-position: 150% 0;
  }
  to {
    background-position: -50% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pending {
    animation: none;
  }
}
</style>
