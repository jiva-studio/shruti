<template>
  <div>
    <span v-html="text" />
  </div>
</template>

<script lang="ts" setup>
defineProps<{
  text: string,
}>()
</script>

<style scoped>
mark { background: yellow; }
</style>