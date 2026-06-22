<template>
  <!--
    Host container for the pure CitationCard. Owns the per-citation IO the
    card used to run internally: track/author metadata lookup, shloka
    reference formatting (sources dictionary), and the inline excerpt player.
    The card itself stays a presentational leaf — see CitationCard.vue.
  -->
  <CitationCard
    :caption="caption"
    :body="body"
    :body-html="bodyHtml"
    :is-mt="isMt"
    :show-original="showOriginal"
    :track-title="trackTitle"
    :author-name="authorName"
    :track-date="trackDate"
    :reference="referenceLabel"
    :language="language"
    :meta-ready="metaLoaded"
    :card-label="t('chat.citationDetailsTitle')"
    :chip-fallback-label="t('chat.citationDetailsTitle')"
    @activate="emit('activate')"
    @update:show-original="showOriginal = $event"
  >
    <!-- Audio is a HOST concern: provide the reused inline player. The player
         owns its own taps (play / seek); stop the bubble so tapping it
         doesn't also fire the card's activate. -->
    <template #player>
      <NotesInlinePlayer
        :note="playerRef"
        :active="active"
        :cut="(a) => shareAudioService.cut(a)"
        :predict-url="(id) => buildServerUrl(activeServer, 'public/shares/audio/' + id + '.mp3')"
        @click.stop
      >
        <template #spinner><IonSpinner name="crescent" class="play-btn-spinner" /></template>
      </NotesInlinePlayer>
    </template>
    <!-- No-body fallback: the interactive (Ionic/audio + long-press) chip. -->
    <template #chip>
      <CitationChip
        :track-id="trackId"
        :start-ms="startMs"
        :end-ms="endMs"
        :caption="caption"
      />
    </template>
  </CitationCard>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue"
import { IonSpinner } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { formatReference } from "@lib/domain/services/references.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useTranslatable } from "@lib/chat/useTranslatable.js"
import { renderExcerptHtml } from "@lib/chat/chatMarkers.js"
import type { ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import NotesInlinePlayer from "@lectorium/views/Notes/NotesInlinePlayer.vue"
import { citationExcerptId } from "../composables/useCitationSnippet.js"
import { useCitationMeta } from "../composables/useCitationMeta.js"
import CitationCard from "@lib/ui/chat/CitationCard.vue"
import CitationChip from "./CitationChip.vue"

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** LLM-generated snippet caption from the marker. */
  caption?: string
  /** Transcript snippet from the owning message's `cites` map; absent ⇒
   *  chip fallback. */
  body?: ChatCiteSnippet
  /** Content language for the rendered excerpt text (HighlightText). */
  language?: string
  active?: boolean
}>()

const emit = defineEmits<{ activate: [] }>()

const { t } = useI18n()
const { shareAudioService, activeServer } = useLectorium()
const appLanguage = useAppLanguage()
const dictionaries = useDictionariesStore()

// Translation toggle + rendered snippet HTML, lifted out of the now-pure
// CitationCard. `useTranslatable` is a pure vue-ref view hook; renderExcerptHtml
// runs the shared excerpt-markdown pipeline.
const snippet = computed(() => props.body ?? null)
const { isMt, showOriginal, displayText } = useTranslatable(() => snippet.value)
const bodyHtml = computed<string>(() => renderExcerptHtml(displayText.value))

// Display metadata only — the action sheet is the host's (see
// CitationActionSheet). `metaLoaded` gates the skeleton → card reveal (#926).
const { track, metaLoaded, trackTitle, authorName } = useCitationMeta(() => ({
  trackId: props.trackId,
  startMs: props.startMs,
  endMs: props.endMs,
  caption: props.caption,
}))

const audioPath = computed<string>(() => {
  if (!track.value) return ""
  const variant = pickPlayableVariant(track.value)
  return variant?.audio?.path ?? ""
})

/**
 * Player ref for the reused NotesInlinePlayer. `noteId` doubles as the
 * excerpt cache id — set to the chat-citation id so the cut excerpt and
 * predicted CDN URL match what the chip's `useCitationSnippet` produces
 * (same public/shares/audio/chat-cite-*.mp3 object — no double cut).
 */
const playerRef = computed(() => ({
  noteId: citationExcerptId({ trackId: props.trackId, startMs: props.startMs, endMs: props.endMs }),
  trackId: props.trackId,
  sourceKey: audioPath.value,
  timeStart: props.startMs,
  timeEnd: props.endMs,
}))

const referenceLabel = computed<string>(() => {
  const first = track.value?.references?.[0]
  if (!first) return ""
  return formatReference(first, dictionaries.sourcesById, appLanguage.value)
})

const trackDate = computed<string>(() => track.value?.date || "")

onMounted(() => {
  // Sources are needed to format the shloka reference, like the Notes
  // list does; one-shot full load, cached across the session.
  void dictionaries.ensureLoaded()
})
</script>
