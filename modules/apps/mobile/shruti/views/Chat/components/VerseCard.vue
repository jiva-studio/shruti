<template>
  <!--
    Block-level verse card: addr header + sanskrit + transliteration +
    translation in the user's UI locale. Renders only when the
    verseBodyStore has the body cached (server streamed it via
    `verse_payload` earlier in the same turn, or persisted from an
    earlier session). Falls back to the inline chip if the body is
    missing — keeps the bubble readable even on a cold cache or when
    library.db hadn't indexed this verse at server-cite time.
  -->
  <article v-if="body" class="verse-card">
    <header class="verse-card-addr">{{ displayAddr }}</header>
    <p v-if="sanskrit" class="verse-card-sanskrit">{{ sanskrit }}</p>
    <p v-if="transliteration" class="verse-card-iast">{{ transliteration }}</p>
    <p v-if="translation" class="verse-card-translation">{{ translation }}</p>
  </article>
  <span
    v-else
    role="button"
    tabindex="0"
    class="verse-chip"
    :aria-label="ariaLabel"
    @click="onTap"
    @keydown.enter.space.prevent="onTap"
  >
    <IconBook2 :size="14" stroke="1.75" class="verse-icon" />
    <span class="verse-caption">{{ displayCaption }}</span>
  </span>
</template>

<script setup lang="ts">
/**
 * Library verse widget. Two render modes:
 *
 *  - body present (cache hit) → block card with addr / sanskrit / IAST
 *    / translation in the active locale.
 *  - body missing → inline chip placeholder with the verse addr.
 *
 * Body comes from `useVerseBodyStore`, populated by the `verse_payload`
 * SSE event the chat server streams ahead of the marker. The store
 * persists across sessions, so a verse cited in a past turn renders as
 * a block immediately on next open.
 */
import { computed, onMounted } from "vue"
import { IconBook2 } from "@tabler/icons-vue"
import { useI18n } from "vue-i18n"
import { useVerseBodyStore } from "@shruti/stores/useVerseBodyStore.js"

const props = defineProps<{
  sourceId: string
  tokens: string
  caption?: string
}>()

const verseBodyStore = useVerseBodyStore()
const { locale } = useI18n()

// Hydrate Preferences-backed cache on first mount of any verse card.
// Cheap no-op after the first call.
onMounted(() => {
  void verseBodyStore.hydrate()
})

const body = computed(() => verseBodyStore.get(props.sourceId, props.tokens))

const displayCaption = computed(() => props.caption?.trim() || props.tokens)
const displayAddr = computed(() => body.value?.addrLabel || props.caption?.trim() || props.tokens)

// gitabase stores multi-line shloka text with blank-line separators
// between half-verses; pre-wrap renders those as ugly empty lines.
// Collapse any run of newlines to a single one so the lines stay
// distinct without the gap.
const sanskrit = computed(() => (body.value?.sanskrit || "").replace(/\n{2,}/g, "\n"))

// The server localises `transliteration` by the turn's lang: Latin IAST
// for `en`, Cyrillic (derived from that IAST) for `ru`. We just render
// the single string it shipped; same newline normalisation as sanskrit.
const transliteration = computed(() => (body.value?.transliteration || "").replace(/\n{2,}/g, "\n"))

const translation = computed(() => {
  const map = body.value?.translation
  if (!map) return ""
  const wanted = locale.value
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
  // Phase 1 chip fallback only. With body present the card already
  // shows everything; no detail view yet.
  console.info("[VerseCard] tap", { sourceId: props.sourceId, tokens: props.tokens })
}
</script>

<style scoped>
.verse-card {
  position: relative;
  display: block;
  margin: 10px 0;
  padding: 10px 0;
  /* Concrete px instead of em so children's px sizes don't compound
     against an em-relative parent. The verse card reads slightly
     smaller than bubble prose (15px) to visually distinguish the
     sub-block. */
  font-size: 14px;
  line-height: 1.45;
}
/* Top & bottom rules rendered as 1px gradient bands instead of solid
 * borders so the line fades in from the edges and peaks in the middle
 * — soft visual divider, no hard corners. */
.verse-card::before,
.verse-card::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.1),
    transparent
  );
  pointer-events: none;
}
.verse-card::before {
  top: 0;
}
.verse-card::after {
  bottom: 0;
}
/* Adjacent verse cards (LLM stacked several): the previous card's
 * bottom band + this card's top band would render as one double-bright
 * line. Drop the top band on the runner-up and collapse the top margin
 * so a single shared rule sits between them. */
.verse-card + .verse-card {
  margin-top: 0;
  /* Zero out the lower stacked card's top padding: the addr header's
   * own line-box leading already provides all the visual breathing
   * room below the shared rule. Anything extra reads as a larger gap
   * below the rule than above. Single (un-stacked) cards keep
   * symmetric 10/10. */
  padding-top: 0;
}
.verse-card + .verse-card::before {
  display: none;
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

.verse-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  margin: 0 2px;
  border-radius: 999px;
  border: 1px solid var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.08);
  color: var(--ion-color-primary);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  vertical-align: baseline;
  transition: background 0.15s ease;
}
.verse-chip:hover,
.verse-chip:focus-visible {
  background: rgba(var(--ion-color-primary-rgb), 0.18);
  outline: none;
}
.verse-icon {
  flex: 0 0 auto;
}
.verse-caption {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 18ch;
}
</style>
