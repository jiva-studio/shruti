<template>
  <div>
    <span v-html="text" />
  </div>
</template>

<script lang="ts" setup>
defineProps<{
  text: string
}>()
</script>

<style scoped>
mark {
  background: rgba(var(--ion-color-warning-rgb), 0.5);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
