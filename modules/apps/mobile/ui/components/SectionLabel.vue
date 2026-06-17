<template>
  <h3 class="section-label" :class="{ inset }"><slot /></h3>
</template>

<script setup lang="ts">
/**
 * Small uppercase micro-heading that labels a content block (e.g. "Contents",
 * "Similar by topic"). The dumb shared leaf — typography lives here, the parent
 * decides the text. `inset` adds the page padding + a little air above for use
 * outside an already-padded list.
 */
defineProps<{ inset?: boolean }>()
</script>

<style scoped>
.section-label {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ion-color-medium, #777);
}

.section-label.inset {
  margin: 16px 0 0;
  padding-inline: var(--ion-padding, 16px);
}
</style>
