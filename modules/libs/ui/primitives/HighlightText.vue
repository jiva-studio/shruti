<template>
  <div class="highlight-text">
    <span v-html="text" />
  </div>
</template>

<script lang="ts" setup>
defineProps<{
  text: string
}>()
</script>

<style scoped>
/*
 * `<mark>` is injected via v-html, so Vue's scoped attribute selector
 * never reaches it. Use :deep() so the rule penetrates the scope and
 * actually styles the highlight.
 */
.highlight-text :deep(mark) {
  background: rgba(var(--ion-color-medium-rgb), 0.22);
  color: inherit;
  border-radius: 4px;
  padding: 1px 4px;
}
</style>
