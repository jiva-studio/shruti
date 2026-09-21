<script setup lang="ts">
/**
 * The round control on the trailing edge of a `FloatingInput`.
 *
 * Only the shell: the size, the colour, and the way it scales in and out. What
 * it shows and what tapping it does belong to the surface that puts it there —
 * a conversation sends, a search clears — which is why they pass a glyph in and
 * listen for `click` rather than sharing a button that has to know about both.
 *
 * `visible` false leaves it in place but out of the way: no size change, so the
 * field beside it never reflows as the button comes and goes.
 */
withDefaults(
  defineProps<{
    /** Shown, or scaled away while keeping its space. */
    visible?: boolean
    disabled?: boolean
    label: string
  }>(),
  { visible: true }
)

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <button
    type="button"
    class="action"
    :class="{ visible }"
    :aria-label="label"
    :disabled="disabled || !visible"
    :tabindex="visible && !disabled ? 0 : -1"
    @click="emit('click')"
  >
    <slot />
  </button>
</template>

<style scoped>
.action {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 0;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transform: scale(0.5);
  opacity: 0;
  pointer-events: none;
  transition:
    transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 140ms ease-out;
  -webkit-tap-highlight-color: transparent;
}

.action.visible {
  transform: scale(1);
  opacity: 1;
  pointer-events: auto;
}

.action:disabled {
  cursor: not-allowed;
}

.action:active:not(:disabled) {
  opacity: 0.75;
}
</style>
