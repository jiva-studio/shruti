<template>
  <div class="timestamp">
    {{ formatTime(start) }}
  </div>
</template>


<script setup lang="ts">
defineProps<{
  start: number
}>()

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

function formatTime(ms: number) {
  const seconds = Math.floor(ms % 60)
  const minutes = Math.floor((ms / 60) % 60)
  const hours = Math.floor(ms / 3600)

  if (hours === 0) {
    return [minutes.toString().padStart(2, '0'), seconds.toString().padStart(2, '0')].join(':')
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
  margin-top: 1rem;
  font-size: .6rem;
}
</style>