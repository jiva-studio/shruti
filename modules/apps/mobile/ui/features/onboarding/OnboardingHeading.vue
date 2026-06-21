<template>
  <div class="ob-heading">
    <h1 class="ob-heading__title">{{ title }}</h1>
    <p v-if="subtitle" class="ob-heading__subtitle">{{ subtitle }}</p>
  </div>
</template>

<script setup lang="ts">
/** The centered title + optional subtitle every onboarding content screen
 *  shares, so the heading layout lives in one place. */
defineProps<{ title: string; subtitle?: string }>()
</script>

<style scoped>
.ob-heading {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
}
.ob-heading__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 700;
  color: var(--ion-text-color);
}
.ob-heading__subtitle {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
</style>
