<template>
  <div v-if="packs.length" class="suggestions" :class="{ 'is-disabled': disabled }">
    <button
      v-for="pack in packs"
      :key="pack.id"
      type="button"
      class="chip"
      @click="onPick(pack.id)"
    >
      {{ pack.name }}
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * Empty-playlist starter-pack chips. Visual twin of
 * `views/Chat/components/SuggestionChips.vue` (same `.suggestions` flex-
 * wrap layout + dashed `.chip` pill), kept as a separate component so
 * the playlist UI doesn't reach into chat i18n / recap logic.
 *
 * Domain-agnostic: knows only "tap a chip emits its id". The Home view
 * resolves the id → track set → playlist.add fan-out, so this stays
 * reusable for any future locale-scoped chip surface.
 */
defineProps<{
  packs: readonly { id: string; name: string }[]
  /** True while a previous tap's playlist.add fan-out is in-flight. */
  disabled: boolean
}>()

const emit = defineEmits<{ (e: "pick", packId: string): void }>()

function onPick(packId: string) {
  emit("pick", packId)
}
</script>

<style scoped>
.suggestions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  margin-top: 14px;
  /* Wider container so chips wrap into 2-3 per row on most phones
   * instead of 1 — matches the chat-side surface. */
  padding: 0 12px;
  width: 100%;
  max-width: 720px;
}

/* Block taps while the previous fan-out is running; the 0.6 opacity
 * mirrors the standard Ionic disabled treatment so the affordance is
 * obvious without flashing a spinner. */
.suggestions.is-disabled {
  pointer-events: none;
  opacity: 0.6;
}

.chip {
  appearance: none;
  border: 1px dashed rgba(var(--ion-color-primary-rgb), 0.45);
  background: transparent;
  color: var(--ion-text-color);
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.25;
  white-space: nowrap;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.chip:active {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}
</style>
