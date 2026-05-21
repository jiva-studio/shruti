<template>
  <div class="focus-card-row" :data-message-id="messageId">
    <ChatFocusPlayer
      :message-id="messageId"
      :source-key="focus.sourceKey"
      :start-ms="focus.startMs"
      :end-ms="focus.endMs"
    />
    <blockquote class="focus-quote">{{ focus.text }}</blockquote>
    <div v-if="suggestionsLoading" class="focus-suggestions-loading">
      <span class="loading-pill">{{ $t("chat.suggestionsLoading") }}</span>
    </div>
    <div v-else-if="visibleChips.length > 0" class="focus-suggestions">
      <button
        v-for="(s, i) in visibleChips"
        :key="i"
        type="button"
        class="suggestion-chip"
        @click="$emit('pick-suggestion', s)"
      >
        {{ s }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Full-width card rendered in place of a user bubble when the chat
 * message carries a `focus` payload (the "Ask Sadhu" flow from a
 * transcript selection).
 *
 * Layout: inline audio scrubber on top, the quoted text as a
 * blockquote below, and discussion chips inlined right after the
 * quote. Each focus card carries its OWN chips — server-generated
 * ones land on `meta.followups` once `/questions` resolves and
 * survive a session reload. The static i18n list (`chat.focusFallback
 * Suggestions`) shows when the server returned nothing.
 *
 * Chips persist across user sends so the user can fire multiple
 * questions about the same fragment without losing the affordance.
 */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { ChatFocusPayload } from "@lib/domain/chatMessage.js"
import ChatFocusPlayer from "./ChatFocusPlayer.vue"

const props = defineProps<{
  messageId: string
  focus: ChatFocusPayload
  /** Persisted chip texts, or `null` while the fetch hasn't resolved
   *  yet (treat as "fall back to static list" until loading kicks in).
   *  An EMPTY array is treated the same as null — server resolved
   *  with no questions, show fallback. */
  suggestions?: readonly string[] | null
  /** Pre-result loading state — shows a "Picking questions…" pill
   *  in place of chips. */
  suggestionsLoading?: boolean
}>()

defineEmits<{ "pick-suggestion": [text: string] }>()

const { tm } = useI18n()

const fallbackChips = computed<readonly string[]>(() => {
  const raw = tm("chat.focusFallbackSuggestions") as unknown
  if (!Array.isArray(raw)) return []
  return raw.filter((q): q is string => typeof q === "string" && q.trim().length > 0)
})

/** Chips to render — server-generated if available, otherwise the
 *  static i18n fallback. Empty array hides the chip row entirely
 *  (only happens when fallback list is also missing in i18n). */
const visibleChips = computed<readonly string[]>(() => {
  const server = props.suggestions
  if (server && server.length > 0) return server
  return fallbackChips.value
})
</script>

<style scoped>
/* Full-width row — no rounded card around player + quote. The player
 * already has its own surface; the quote uses just a left bar. Wrapping
 * both in a tinted card was visual noise that the user pushed back on. */
.focus-card-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 8px;
  margin: 12px 0;
  padding: 0 12px;
}

.focus-quote {
  margin: 0;
  padding: 4px 0 0 10px;
  border-left: 3px solid rgba(var(--ion-color-primary-rgb), 0.55);
  color: var(--ion-text-color);
  font-style: italic;
  line-height: 1.4;
  font-size: 14px;
  white-space: pre-wrap;
  /* Allow long quotes to wrap rather than overflow horizontally. */
  word-break: break-word;
}

.focus-suggestions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}

.suggestion-chip {
  appearance: none;
  border: 1px dashed rgba(var(--ion-color-primary-rgb), 0.45);
  background: transparent;
  color: var(--ion-text-color);
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.25;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

.suggestion-chip:active {
  background: rgba(var(--ion-color-primary-rgb), 0.1);
}

.focus-suggestions-loading {
  display: flex;
  margin-top: 4px;
}

.loading-pill {
  display: inline-flex;
  align-items: center;
  font-size: 12px;
  font-style: italic;
  color: var(--ion-color-medium);
  background: rgba(var(--ion-color-medium-rgb), 0.08);
  padding: 4px 12px;
  border-radius: 999px;
}
</style>
