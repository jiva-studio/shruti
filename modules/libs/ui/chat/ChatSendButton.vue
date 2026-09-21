<script setup lang="ts">
import FloatingInputButton from "../input/FloatingInputButton.vue"

/**
 * What a conversation puts on the trailing edge of a `FloatingInput`: an arrow
 * that appears once there is something to send, and a Stop while a turn is
 * streaming.
 *
 * Chat-specific and shared by every chat there is — the mobile tab and the
 * three on the web — so the gesture and the glyph are decided once. The round
 * shell underneath is `FloatingInputButton`, which the search field wears too.
 */
defineProps<{
  /** A turn is streaming: the arrow becomes the `#spinner` slot and a Stop. */
  sending: boolean
  disabled?: boolean
  /** Whether the field has anything to send. */
  hasText: boolean
  label: string
}>()

const emit = defineEmits<{ send: []; cancel: [] }>()
</script>

<template>
  <FloatingInputButton
    :visible="sending || (hasText && !disabled)"
    :disabled="disabled"
    :label="label"
    @click="sending ? emit('cancel') : emit('send')"
  >
    <span v-if="sending" class="spinner"><slot name="spinner" /></span>
    <svg
      v-else
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  </FloatingInputButton>
</template>

<style scoped>
.spinner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
}
</style>
