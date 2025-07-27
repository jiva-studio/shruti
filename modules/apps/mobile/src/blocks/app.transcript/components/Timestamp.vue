<template>
  <div class="timestamp">
    <div>{{ formatTime(start) }}</div>
    <div>-{{ formatTime(duration - start) }}</div>
  </div>
</template>


<script setup lang="ts">
defineProps<{
  start: number
  duration: number
}>()

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function formatTime(ms: number) {
  const seconds = Math.floor(ms % 60)
  const minutes = Math.floor((ms / 60) % 60)
  const hours = Math.floor(ms / 3600)

  if (hours === 0) {
    return [
      minutes.toString().padStart(2, '0'), 
      seconds.toString().padStart(2, '0')
    ].join(':')
  } else {
    return [
      hours.toString(),
      minutes.toString().padStart(2, '0'),
      seconds.toString().padStart(2, '0')
    ].join(':')
  }
}
</script>

<style scoped>
.timestamp {
  font-size: .6rem;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
  opacity: .5;
  /* font-variant-numeric: tabular-nums; */
  letter-spacing: 0.03em;
}
</style>