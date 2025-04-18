<template>
  <h3 class="sectionHeader">
    {{ title }}
  </h3>
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
}
</style>