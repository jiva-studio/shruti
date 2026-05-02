<template>
  <IonIcon aria-hidden="true" :icon="statusIcon.icon" :color="statusIcon.color" />
</template>

<script lang="ts" setup>
import { computed } from "vue"
import { IonIcon } from "@ionic/vue"
import { closeCircle, checkmarkCircle, checkmarkDoneCircle } from "ionicons/icons"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type StateIcon = "none" | "failed" | "added" | "completed"

const props = defineProps<{
  icon: StateIcon
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

type StateIconMap = {
  [key in StateIcon]: { icon?: string; color?: string }
}

const stateIconMaps: StateIconMap = {
  none: { icon: undefined, color: undefined },
  failed: { icon: closeCircle, color: "danger" },
  added: { icon: checkmarkCircle, color: "primary" },
  completed: { icon: checkmarkDoneCircle, color: "medium" },
}
const statusIcon = computed(() => stateIconMaps[props.icon])
</script>
