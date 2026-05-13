<template>
  <component
    v-if="statusIcon.icon"
    :is="statusIcon.icon"
    aria-hidden="true"
    :size="20"
    :style="{ color: `var(--ion-color-${statusIcon.color})` }"
  />
</template>

<script lang="ts" setup>
import { computed, type Component } from "vue"
import {
  IconCircleCheckFilled,
  IconCircleXFilled,
  IconRosetteDiscountCheckFilled,
} from "@tabler/icons-vue"

export type StateIcon = "none" | "failed" | "added" | "completed"

const props = defineProps<{
  icon: StateIcon
}>()

type StateIconMap = {
  [key in StateIcon]: { icon?: Component; color?: string }
}

const stateIconMaps: StateIconMap = {
  none: { icon: undefined, color: undefined },
  failed: { icon: IconCircleXFilled, color: "danger" },
  added: { icon: IconCircleCheckFilled, color: "primary" },
  completed: { icon: IconRosetteDiscountCheckFilled, color: "medium" },
}
const statusIcon = computed(() => stateIconMaps[props.icon])
</script>
