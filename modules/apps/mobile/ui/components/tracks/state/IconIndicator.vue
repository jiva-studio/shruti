<template>
  <span
    v-if="statusIcon.icon"
    class="state-icon"
    :style="{ color: `var(--ion-color-${statusIcon.color})` }"
  >
    <component :is="statusIcon.icon" aria-hidden="true" :size="iconSize" />
  </span>
</template>

<script lang="ts" setup>
import { computed, type Component } from "vue"
import { IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"
import { IconCircleCheckFilled, IconCircleXFilled } from "@tabler/icons-vue"

export type StateIcon = "none" | "failed" | "added" | "completed"

const props = defineProps<{
  icon: StateIcon
}>()

type StateIconEntry = { icon?: Component; color?: string; size: number }
type StateIconMap = { [key in StateIcon]: StateIconEntry }

// All icons render inside the 24×24 box below, which matches
// `RadialIndicator.diameter` — keeps indicator column width identical
// across rows so the list doesn't jitter between states.
const stateIconMaps: StateIconMap = {
  none: { icon: undefined, color: undefined, size: 24 },
  failed: { icon: IconCircleXFilled, color: "danger", size: 24 },
  added: { icon: IconCircleCheckFilled, color: "primary", size: 24 },
  completed: { icon: IconRosetteDiscountCheckFilled, color: "medium", size: 24 },
}
const statusIcon = computed(() => stateIconMaps[props.icon])
const iconSize = computed(() => statusIcon.value.size)
</script>

<style scoped>
.state-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
}
</style>
