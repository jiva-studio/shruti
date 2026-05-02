<template>
  <div class="circle-progress">
    <svg viewBox="0 0 36 36">
      <circle class="bg" cx="18" cy="18" r="14" />
      <circle
        class="progress"
        cx="18"
        cy="18"
        r="14"
        :stroke-dasharray="circumference"
        :stroke-dashoffset="dashOffset"
      />
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    /** Filled portion in 0..100. */
    progress: number
    /** Stroke radius in viewBox units (max 18). */
    radius?: number
  }>(),
  { radius: 14 }
)

const circumference = computed(() => 2 * Math.PI * props.radius)
const dashOffset = computed(
  () => circumference.value - (props.progress / 100) * circumference.value
)
</script>

<style scoped>
.circle-progress {
  width: 24px;
  height: 24px;
  position: absolute;
  right: 0px;
  top: 50%;
  transform: translateY(-50%);
  opacity: 0.8;
}

svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

circle.bg {
  fill: none;
  stroke: #eee;
  stroke-width: 5;
}

circle.progress {
  fill: none;
  stroke: var(--ion-color-dark);
  stroke-width: 5;
  transition: stroke-dashoffset 0.1s linear;
}
</style>
