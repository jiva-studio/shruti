<script setup lang="ts">
import FloatingInputButton from "@lib/ui/input/FloatingInputButton.vue"

/** Two discs sharing one cell, so one shrinks away exactly where the other
 *  grows in and nothing shifts. */
defineProps<{
  hasText: boolean
  searchLabel: string
  clearLabel: string
}>()

const emit = defineEmits<{ clear: [] }>()
</script>

<template>
  <span class="buttons">
    <FloatingInputButton class="stacked" :visible="!hasText" :label="searchLabel">
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
    </FloatingInputButton>
    <FloatingInputButton
      class="stacked"
      :visible="hasText"
      :label="clearLabel"
      @click="emit('clear')"
    >
      <svg
        viewBox="0 0 24 24"
        width="20"
        height="20"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </FloatingInputButton>
  </span>
</template>

<style scoped>
/* The two discs share one cell, so one can shrink away exactly where the other
   grows in and nothing shifts. */
.buttons {
  position: relative;
  display: grid;
  width: 36px;
  height: 36px;
}

.stacked {
  grid-area: 1 / 1;
}
</style>
