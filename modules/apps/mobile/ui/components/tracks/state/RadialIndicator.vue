<template>
  <RadialProgress
    :stroke-width="4"
    :inner-stroke-width="4"
    :diameter="24"
    :completed-steps="value"
    :total-steps="100"
    :animate-speed="750"
    :start-color="`var(--ion-color-${color})`"
    :stop-color="`var(--ion-color-${color})`"
    inner-stroke-color="rgba(var(--ion-color-primary-rgb), 0.22)"
  />
</template>

<script lang="ts" setup>
import RadialProgress from "vue3-radial-progress"

withDefaults(
  defineProps<{
    value: number
    color: string
  }>(),
  {
    value: 0,
    color: "primary",
  }
)
</script>
