<script setup lang="ts">
/**
 * Library verse widget. Two render modes:
 *
 *  - body present (cache hit) → block card with addr / sanskrit / IAST
 *    / translation in the active locale.
 *  - body missing → inline chip placeholder with the verse addr.
 *
 * Body comes from the owning message's `verses` map (the `verse_payload`
 * SSE event is stashed there during the turn and persisted to SQLite), so
 * a verse cited in a past turn renders as a block immediately on reopen.
 */
import { computed, ref } from "vue"
// `showOriginal` toggles the verse translation between the active-locale
// machine translation and the original English.
import type { UiChatVerseBody } from "./types.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"
import ScriptureChip from "./ScriptureChip.vue"
import ScriptureBlock from "./ScriptureBlock.vue"

const props = withDefaults(
  defineProps<{
    sourceId: string
    tokens: string
    caption?: string
    /** Verse body from the message's `verses` map; absent ⇒ chip fallback. */
    body?: UiChatVerseBody
    /** Active UI locale. Only picks the translation when the body carries no
     *  `lang` of its own (a body streamed by an older server). */
    locale: string
    /** Recitation playing — drives the play/pause glyph. Owned by the host. */
    isPlaying?: boolean
    /** Recitation buffering — shows the `#spinner` slot. Owned by the host. */
    isPreparing?: boolean
    /** Whether a recitation exists; defaults to `body.audioUrl` presence. */
    hasAudio?: boolean
  }>(),
  {
    caption: undefined,
    body: undefined,
    isPlaying: false,
    isPreparing: false,
    hasAudio: undefined,
  }
)

defineEmits<{ "toggle-audio": [] }>()

const body = computed(() => props.body ?? null)

const hasAudio = computed<boolean>(() =>
  props.hasAudio !== undefined ? props.hasAudio : !!body.value?.audioUrl
)

const displayCaption = computed(() => props.caption?.trim() || props.tokens)
const displayAddr = computed(() => body.value?.addrLabel || props.caption?.trim() || props.tokens)

// gitabase stores multi-line shloka text with blank-line separators
// between half-verses; pre-wrap renders those as ugly empty lines.
// Collapse any run of newlines to a single one so the lines stay
// distinct without the gap.
const sanskrit = computed(() => (body.value?.sanskrit || "").replace(/\n{2,}/g, "\n"))

// The server localises `transliteration` by the turn's lang: Latin IAST
// for `en`, Cyrillic (derived from that IAST) for `ru`/`sr`. When the user
// flips to the original (machine-translated verse) we show the IAST source
// transliteration too, so the whole verse returns to its original form.
const transliteration = computed(() => {
  const b = body.value
  if (!b) return ""
  const s =
    showOriginal.value && b.transliterationOriginal ? b.transliterationOriginal : b.transliteration
  return (s || "").replace(/\n{2,}/g, "\n")
})

// The language the verse is shown in — the answer language, named on the body
// by the server. The UI locale only stands in for a body without it.
const displayLang = computed(() => body.value?.lang || props.locale)

// True when the shown translation is a machine translation AND an original
// English entry exists to flip to.
const isMt = computed<boolean>(() => {
  const map = body.value?.translation
  return !!body.value?.mt && !!map && !!map.en && map[displayLang.value] !== map.en
})
// Toggle between the (shown) machine translation and the original English.
const showOriginal = ref(false)

const translation = computed(() => {
  const map = body.value?.translation
  if (!map) return ""
  // When toggled to the original on a machine-translated verse, render the
  // English entry verbatim.
  if (isMt.value && showOriginal.value && map.en) return map.en
  const wanted = displayLang.value
  if (map[wanted]) return map[wanted]
  // Fallback chain: any English text, then the first available.
  if (map.en) return map.en
  const first = Object.values(map)[0]
  return first ?? ""
})
const ariaLabel = computed(
  () => `Verse ${displayCaption.value} (${props.sourceId} ${props.tokens})`
)

function onTap() {
  // Intentional no-op: the expanded card already shows the verse in full, so
  // tapping the chip has nothing to open. Kept as the @tap target so the chip
  // still gives press feedback; wire a detail view here if one is ever added.
}
</script>

<template>
  <!--
    Block-level verse card: addr header + sanskrit + transliteration +
    translation in the user's UI locale. Renders only when the message
    carries this verse's `body` (server streamed it via `verse_payload`
    during the turn). Falls back to the inline chip if the body is
    missing — keeps the bubble readable for pre-feature history or when
    library.db hadn't indexed this verse at server-cite time.
  -->
  <ScriptureBlock v-if="body">
    <button v-if="hasAudio" type="button" class="verse-play" @click="$emit('toggle-audio')">
      <span v-if="isPreparing" class="verse-play-spinner"><slot name="spinner" /></span>
      <svg v-else-if="isPlaying" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
        <path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
        <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
        <path
          d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z"
        />
      </svg>
    </button>
    <header class="verse-card-addr">{{ displayAddr }}</header>
    <p v-if="sanskrit" class="verse-card-sanskrit">{{ sanskrit }}</p>
    <AutoHeight>
      <p v-if="transliteration" class="verse-card-iast">{{ transliteration }}</p>
      <p v-if="translation" class="verse-card-translation">{{ translation }}</p>
    </AutoHeight>
  </ScriptureBlock>
  <ScriptureChip v-else :caption="displayCaption" :aria-label="ariaLabel" @tap="onTap" />

  <TranslationNotice v-if="isMt" v-model:show-original="showOriginal" />
</template>

<style scoped>
/* Block layout + the gradient dividers live in the shared `.scripture-block`
 * class (theme/misc.css); only verse-specific content styling is below. */

/* Small semi-transparent round play button, pinned to the card's
 * top-right corner. The card is position:relative so it anchors here. */
.verse-play {
  position: absolute;
  top: 6px;
  right: 0;
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
  backdrop-filter: blur(2px);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition:
    background 0.1s ease,
    transform 0.1s ease;
  z-index: 1;
}
/* Pressed state (mobile — no hover). */
.verse-play:active {
  background: rgba(var(--ion-color-primary-rgb), 0.28);
  transform: scale(0.92);
}
.verse-play-spinner {
  --color: var(--ion-color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}
.verse-play-spinner :deep(*) {
  width: 100%;
  height: 100%;
}
.verse-card-addr {
  font-weight: 700;
  font-size: 0.88em;
  text-align: center;
  color: var(--ion-color-primary);
  margin: 0 0 2px;
}
.verse-card-sanskrit {
  margin: 0 0 2px;
  text-align: center;
  font-family: "Sanskrit2003", "Noto Sans Devanagari", serif;
  /* Slightly larger than the surrounding text — sanskrit is the
     headline content of the verse and reads better with a touch
     more weight. */
  font-size: 1.12em;
  white-space: pre-wrap;
}
.verse-card-iast {
  margin: 0 0 4px;
  text-align: center;
  font-style: italic;
  color: var(--ion-color-medium);
  white-space: pre-wrap;
}
.verse-card-translation {
  margin: 0;
  white-space: pre-wrap;
}
</style>
