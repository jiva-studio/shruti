<template>
  <div class="chip-list-container">
    <slot />
  </div>
</template>

<script setup lang="ts">
</script>

<style scoped>
.chip-list-container {
  width: 100%;
  overflow-x: auto;
  white-space: nowrap;

  -ms-overflow-style: none;
  scrollbar-width: none;
}

.chip-list-container::-webkit-scrollbar {
  display: none;
}
</style>