<script setup lang="ts">
import { computed } from "vue"

const props = withDefaults(
  defineProps<{
    start: number
    duration: number
    /**
     * When false (preview mode — transcript not tied to live playback),
     * the remaining-time half is suppressed and only the paragraph's
     * static `start` is shown. See useTranscriptDialogController for
     * the gating rationale.
     */
    showRemaining?: boolean
  }>(),
  { showRemaining: true }
)

// Defence-in-depth: also suppress remaining-time when duration is 0,
// so a stale caller can't render "MM:SS • -MM:SS".
const showRemainingResolved = computed(() => props.showRemaining && props.duration > 0)

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  if (hours === 0) {
    return [minutes.toString().padStart(2, "0"), seconds.toString().padStart(2, "0")].join(":")
  } else {
    return [
      hours.toString(),
      minutes.toString().padStart(2, "0"),
      seconds.toString().padStart(2, "0"),
    ].join(":")
  }
}
</script>

<template>
  <div class="timestamp">
    <div>{{ formatTime(start) }}</div>
    <template v-if="showRemainingResolved">
      <div>•</div>
      <div>{{ formatTime(duration - start) }}</div>
    </template>
  </div>
</template>

<style scoped>
.timestamp {
  font-size: 0.6rem;
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  opacity: 0.5;
  letter-spacing: 0.03em;
  gap: 0.4rem;
}
</style>
