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
    <button v-if="audioUrl" type="button" class="verse-play" @click="onToggle">
      <slot v-if="isPreparing" name="spinner" />
      <svg v-else-if="isPlaying" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
        <path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
        <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
        <path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" />
      </svg>
    </button>
    <header class="verse-card-addr">{{ displayAddr }}</header>
    <p v-if="sanskrit" class="verse-card-sanskrit">{{ sanskrit }}</p>
    <AutoHeight>
      <p v-if="transliteration" class="verse-card-iast">{{ transliteration }}</p>
      <p v-if="translation" class="verse-card-translation">{{ translation }}</p>
    </AutoHeight>
    <audio
      v-if="audioUrl"
      ref="audioEl"
      preload="none"
      @ended="onEnded"
      @pause="onPause"
      @play="onPlay"
      @playing="onPlaying"
      @canplay="onCanPlay"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @error="onError"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onMetadata"
    />
  </ScriptureBlock>
  <ScriptureChip v-else :caption="displayCaption" :aria-label="ariaLabel" @tap="onTap" />

  <TranslationNotice v-if="isMt" v-model:show-original="showOriginal" />
</template>

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
import type { ChatVerseBody } from "@lib/domain/chatMessage.js"
import { useExcerptAudioPlayer } from "@lectorium/composables/useExcerptAudioPlayer.js"
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
    body?: ChatVerseBody
    /** Active UI locale; picks the translation/transliteration language. */
    locale: string
    /** Maps a raw audio URL to a playable one (cache/io); identity by default. */
    resolveAudioUrl?: (rawUrl: string) => Promise<string>
  }>(),
  {
    caption: undefined,
    body: undefined,
    resolveAudioUrl: (u: string) => Promise.resolve(u),
  }
)

const body = computed(() => props.body ?? null)

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

// True when the active-locale translation is a machine translation AND an
// original English entry exists to flip to.
const isMt = computed<boolean>(() => {
  const map = body.value?.translation
  return !!body.value?.mt && !!map && !!map.en && map[props.locale] !== map.en
})
// Toggle between the (shown) machine translation and the original English.
const showOriginal = ref(false)

const translation = computed(() => {
  const map = body.value?.translation
  if (!map) return ""
  // When toggled to the original on a machine-translated verse, render the
  // English entry verbatim.
  if (isMt.value && showOriginal.value && map.en) return map.en
  const wanted = props.locale
  if (map[wanted]) return map[wanted]
  // Fallback chain: any English text, then the first available.
  if (map.en) return map.en
  const first = Object.values(map)[0]
  return first ?? ""
})
const ariaLabel = computed(
  () => `Verse ${displayCaption.value} (${props.sourceId} ${props.tokens})`
)

// Sanskrit recitation, present only when the library has audio for this
// verse — a whole-file public URL (no excerpt cut). Routed through the
// excerpt cache (same as the citation chip): the first tap downloads the
// mp3, later taps + offline play the local copy.
const audioUrl = computed(() => body.value?.audioUrl || "")

// Local URL of the cached recitation; null until the first tap resolves it
// so the player takes its prepare-then-play (spinner) branch on first play.
const localUri = ref<string | null>(null)

async function resolveVerseAudio(): Promise<string> {
  const url = await props.resolveAudioUrl(audioUrl.value)
  localUri.value = url
  return url
}

const {
  audioEl,
  isPlaying,
  isPreparing,
  onToggle,
  onPlay,
  onPause,
  onEnded,
  onTimeUpdate,
  onMetadata,
  onWaiting,
  onPlaying,
  onCanPlay,
  onError,
} = useExcerptAudioPlayer({
  hasSource: () => !!audioUrl.value,
  cachedUrl: () => localUri.value,
  resolveUrl: resolveVerseAudio,
  logLabel: "verse-audio",
})

function onTap() {
  // Intentional no-op: the expanded card already shows the verse in full, so
  // tapping the chip has nothing to open. Kept as the @tap target so the chip
  // still gives press feedback; wire a detail view here if one is ever added.
}
</script>

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
.verse-play-spin {
  width: 12px;
  height: 12px;
  --color: var(--ion-color-primary);
}
.verse-card-addr {
  font-weight: 700;
  font-size: 13px;
  text-align: center;
  color: var(--ion-color-primary);
  margin: 0 0 2px;
}
.verse-card-sanskrit {
  margin: 0 0 2px;
  text-align: center;
  font-family: "Sanskrit2003", "Noto Sans Devanagari", serif;
  /* Slightly larger than the bubble base — sanskrit is the
     headline content of the verse and reads better with a touch
     more weight. */
  font-size: 16px;
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
