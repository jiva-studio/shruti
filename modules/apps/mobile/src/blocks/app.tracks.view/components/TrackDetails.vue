<template>
  <p class="details">
    {{ sections }}
  </p>
</template>


<script setup lang="ts">
import { computed, toRefs } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  author?: string
  location?: string
  date?: string
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { author, location, date } = toRefs(props)

const sections = computed(() => {
  return [
    author.value,
    location.value,
    date.value
  ].filter(Boolean).join(' • ')
})
</script>
