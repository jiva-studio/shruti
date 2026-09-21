<script setup lang="ts">
defineProps<{
  name: string
  withBreak: boolean
}>()
</script>

<template>
  <br v-if="withBreak" />
  <strong class="tx-speaker">{{ name }}:&nbsp;</strong>
</template>

<style scoped>
.tx-speaker {
  font-weight: 700;
  color: var(--ion-color-primary);
}
</style>
