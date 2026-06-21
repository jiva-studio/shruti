<template>
  <button
    type="button"
    class="toggle-chip"
    :class="{ 'toggle-chip--on': selected }"
    :disabled="disabled"
    :role="role"
    :aria-pressed="role === undefined ? selected : undefined"
    :aria-checked="role === 'radio' ? selected : undefined"
    @click="emit('toggle')"
  >
    <slot />
  </button>
</template>

<script setup lang="ts">
/**
 * Outline pill that fills with the primary colour when selected — the single
 * source of the topic / time chips used by the onboarding topic picker, the
 * daily-wisdom screen, and the Settings daily-wisdom dialog.
 *
 * `role` is omitted for multi-select groups (the chip reports `aria-pressed`)
 * and set to `"radio"` for single-select groups (reports `aria-checked`).
 */
defineProps<{
  selected: boolean
  disabled?: boolean
  role?: "radio"
}>()

const emit = defineEmits<{ toggle: [] }>()
</script>

<style scoped>
.toggle-chip {
  padding: 10px 16px;
  border-radius: 999px;
  border: 1.5px solid var(--ion-color-step-200, #e0e0e0);
  background: transparent;
  color: var(--ion-text-color);
  font-size: 0.92rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;
}
.toggle-chip--on {
  border-color: var(--ion-color-primary);
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}
.toggle-chip:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
