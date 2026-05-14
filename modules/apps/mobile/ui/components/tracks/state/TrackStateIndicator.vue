<template>
  <Transition name="fade" mode="out-in">
    <IconIndicator v-if="mode === 'icon'" slot="end" key="icon" :icon="icon" />
    <RadialIndicator
      v-else-if="mode === 'downloading'"
      slot="end"
      key="downloadProgress"
      color="medium"
      :value="progress || 0"
    />
    <RadialIndicator
      v-else-if="mode === 'progress'"
      slot="end"
      key="playbackProgress"
      color="medium"
      :value="progress || 0"
    />
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue"
import IconIndicator, { type StateIcon } from "./IconIndicator.vue"
import RadialIndicator from "./RadialIndicator.vue"
import type { UiTrackState } from "./types.js"

const props = defineProps<{
  state: UiTrackState
  /**
   * 0..100 radial value. Interpretation follows `state`:
   * "downloading" → download %, "playing"/"queued" → playback %.
   */
  progress?: number
}>()

const icon = computed<StateIcon>(() => {
  if (props.state === "failed") return "failed"
  if (props.state === "completed") return "completed"
  if (props.state === "added") return "added"
  return "none"
})

const mode = computed<"downloading" | "icon" | "progress" | undefined>(() => {
  if (props.state === "downloading") return "downloading"
  if (props.state === "failed" || props.state === "completed" || props.state === "added")
    return "icon"
  if (props.state === "playing" || props.state === "queued") return "progress"
  return undefined
})
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
