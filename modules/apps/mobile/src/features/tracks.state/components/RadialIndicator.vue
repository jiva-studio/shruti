<template>
  <RadialProgress
    :stroke-width="4"
    :inner-stroke-width="4"
    :diameter="24"
    :completed-steps="progress"
    :total-steps="100"
    :animate-speed="750"
    start-color="var(--ion-color-primary)"
    stop-color="var(--ion-color-primary)"
    inner-stroke-color="var(--ion-color-light)"
  />
</template>


<script lang="ts" setup>
import RadialProgress from 'vue3-radial-progress'

defineProps<{
  progress: number
}>()
</script>
