<template>
  <div class="section-header">
    <h4 class="section-header-title">{{ title }}</h4>
    <div v-if="$slots.default" class="section-header-trailing">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  /** Left-aligned section title (already-translated text — kit is i18n-agnostic). */
  title: string
}>()
</script>

<style scoped>
.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--ion-padding, 16px);
  margin: 1.33em 0 8px;
}

.section-header-title {
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.section-header-trailing {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
</style>
