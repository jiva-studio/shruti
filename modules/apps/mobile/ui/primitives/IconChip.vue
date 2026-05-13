<template>
  <div class="settings-item-icon" :class="{ 'settings-item-icon--danger': danger }">
    <slot />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  danger?: boolean
}>()
</script>
