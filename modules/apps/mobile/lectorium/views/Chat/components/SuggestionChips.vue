<template>
  <div v-if="chips.length" class="suggestions">
    <button
      v-for="(s, i) in chips"
      :key="i"
      type="button"
      class="chip"
      @click="onPick(s)"
    >
      {{ s }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { useTrackUserState } from "@lectorium/composables/useTrackUserState.js"

const props = withDefaults(
  defineProps<{
    /** Player is open / paused with engagement — outline targets that track. */
    hasCurrentTrack?: boolean
    limit?: number
  }>(),
  { hasCurrentTrack: false, limit: 4 }
)

const emit = defineEmits<{ (e: "pick", text: string): void }>()

const { tm, t } = useI18n()
const trackUserState = useTrackUserState()

// Whether the user has ANY listening_sessions row — picks the
// "recap last lecture" chip when there's no active player.
const hasRecentListening = ref(false)

onMounted(async () => {
  try {
    const recent = await trackUserState.listRecent(1)
    hasRecentListening.value = recent.length > 0
  } catch {
    hasRecentListening.value = false
  }
})

/** First-chip text — picks the most specific phrasing the user can read:
 *   current → "Перескажи текущую лекцию"
 *   recent  → "Перескажи последнюю лекцию"
 *   none    → omit (no "what lecture?" recap chip when there's nothing). */
const recapChip = computed<string | null>(() => {
  if (props.hasCurrentTrack) return t("chat.suggestionRecapCurrent")
  if (hasRecentListening.value) return t("chat.suggestionRecapRecent")
  return null
})

const chips = computed<string[]>(() => {
  const pool = readSuggestions()
  const shuffled = shuffle(pool)
  const recap = recapChip.value
  const head = recap ? [recap] : []
  return [...head, ...shuffled].slice(0, Math.max(1, props.limit))
})

function readSuggestions(): string[] {
  const raw = tm("chat.suggestions") as unknown
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === "string" && x.length > 0)
  }
  return []
}

function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function onPick(text: string) {
  emit("pick", text)
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
   * instead of 1 — the only thing that changed from the original. */
  padding: 0 12px;
  width: 100%;
  max-width: 720px;
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
