<script setup lang="ts">
defineProps<{
  /** Whether the annotated card is currently showing the original (vs the
   *  translation). Drives the toggle label. */
  showOriginal: boolean
}>()
const emit = defineEmits<{
  (e: "update:showOriginal", value: boolean): void
}>()
</script>

<template>
  <!-- Machine-translation caption + original/translation toggle. Sits
       BELOW and OUTSIDE the card it annotates, right-aligned. Reused by
       every chat card that can show a machine-translated snippet. -->
  <div class="translation-notice">
    <span class="translation-notice__badge">{{ $t("chat.citationMtBadge") }}</span>
    <span class="translation-notice__sep" aria-hidden="true">·</span>
    <button
      type="button"
      class="translation-notice__toggle"
      @click="emit('update:showOriginal', !showOriginal)"
    >
      {{ showOriginal ? $t("chat.citationViewTranslated") : $t("chat.citationViewOriginal") }}
    </button>
  </div>
</template>

<style scoped>
.translation-notice {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 5px;
  margin: -4px 2px 10px;
  font-size: 11px;
  /* --ion-color-medium already reads as muted; no opacity on top (it would
     also dim the actionable toggle button nested inside). */
  color: var(--ion-color-medium);
}
.translation-notice__toggle {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-color-primary);
  font-size: 11px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
</style>
