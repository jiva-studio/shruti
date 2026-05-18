<template>
  <div v-if="chips.length" class="followups" role="list">
    <button
      v-for="(text, i) in chips"
      :key="i"
      type="button"
      class="chip"
      role="listitem"
      :aria-label="t('chat.followupAriaLabel', { text })"
      @click="onPick(text)"
    >
      {{ text }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"

const props = defineProps<{
  /** Chip texts emitted by the LLM via `[followup:<text>]` markers,
   *  already parsed and capped at 3 by the marker parser. */
  followups: readonly string[]
}>()

const emit = defineEmits<{ (e: "pick", text: string): void }>()

const { t } = useI18n()

const chips = computed<readonly string[]>(() =>
  props.followups.filter((s) => typeof s === "string" && s.length > 0)
)

function onPick(text: string) {
  emit("pick", text)
}
</script>

<style scoped>
.followups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 4px 12px 12px;
  /* Right-aligned because tapping a chip sends it as a user message,
   * and user bubbles live on the right — anchoring chips there reads
   * as "tap one of these and it becomes your next message". */
  justify-content: flex-end;
}

/* Mirrors SuggestionChips.vue so empty-state and inline chips read as
 * the same control. */
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
