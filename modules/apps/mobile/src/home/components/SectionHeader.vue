<template>
  <h4 class="sectionHeader">
    {{ title }}
  </h4>
</template>

<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<style scoped>
.sectionHeader {
  margin-left: var(--ion-padding, 16px);
  margin-right: var(--ion-padding, 16px);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>