<template>
  <h1>{{ title }}</h1>
  <h3>{{ author }}</h3>
</template>


<script setup lang="ts">
defineProps<{
  title: string,
  author: string,
  references: string[]
}>()
</script>
