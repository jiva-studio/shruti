<template>
  <span
    v-if="icon"
    class="icon"
  >
    {{ icon }}
  </span>
  {{ text + " " }}
</template>


<script lang="ts" setup>
defineProps<{
  text: string,
  icon?: string
}>()
</script>


<style scoped>
.icon {
  opacity: .8;
  font-size: .6rem;
  text-align: right;
  transform: translateY(-100px);
  position: relative;
  top: -2px;
}
</style>
