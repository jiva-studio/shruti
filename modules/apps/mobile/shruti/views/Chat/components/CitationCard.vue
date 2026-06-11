<template>
  <!--
    Two render modes, like VerseCard:
      • transcript text known  → full quote card (player + text + attrs)
      • text absent / not yet  → the small CitationChip, reused as-is.
    The store read is reactive, so a chip upgrades to the card the moment
    the `cite_transcript` payload lands (it may arrive after the marker).
  -->
  <!-- Block wrapper so the chip sits on its own line (own line + a line
       after it), matching the card / quote — a citation never flows
       inline mid-sentence. -->
  <div v-if="!snippetText" class="citation-chip-line">
    <CitationChip :track-id="trackId" :start-ms="startMs" :end-ms="endMs" :caption="caption" />
  </div>
  <div
    v-else
    class="citation-card"
    role="button"
    tabindex="0"
    :aria-label="actionSheetHeader || $t('chat.citationDetailsTitle')"
    @click="onOpenActions"
    @keydown.enter.space.prevent="onOpenActions"
  >
    <ExcerptCard
      :text="displayText"
      :author-name="authorName"
      :track-title="trackTitle"
      :reference="referenceLabel"
      :track-date="trackDate"
    >
      <template #player>
        <!-- The player owns its own taps (play / seek); stop the bubble
             so tapping it doesn't also open the action sheet. -->
        <NotesInlinePlayer :note="playerRef" @click.stop />
      </template>
    </ExcerptCard>

    <IonActionSheet
      :is-open="actionSheetOpen"
      :header="actionSheetHeader"
      :buttons="actionSheetButtons"
      @did-dismiss="actionSheetOpen = false"
    />
  </div>

  <!-- Machine-translation footnote: lives BELOW and OUTSIDE the quote
       frame, right-aligned, so it reads as a caption on the card rather
       than part of the quoted text. Shown only when the snippet is MT. -->
  <div v-if="isMt" class="cite-mt-line">
    <span class="cite-mt-badge">{{ $t("chat.citationMtBadge") }}</span>
    <button type="button" class="cite-mt-toggle" @click="showOriginal = !showOriginal">
      {{ showOriginal ? $t("chat.citationViewTranslated") : $t("chat.citationViewOriginal") }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonActionSheet } from "@ionic/vue"
import router from "@shruti/router/index.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { formatReference } from "@lib/domain/services/references.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useChatActions } from "@shruti/composables/useChatActions.js"
import { useCiteTranscriptStore } from "@shruti/stores/useCiteTranscriptStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useStudioHandoffStore } from "@shruti/stores/useStudioHandoffStore.js"
import { useToast } from "@kit/composables"
import type { AuthorId, TrackId } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"
import { ExcerptCard } from "@ui/components/excerpt/index.js"
import NotesInlinePlayer from "@shruti/views/Notes/NotesInlinePlayer.vue"
import { citationExcerptId } from "../composables/useCitationSnippet.js"
import CitationChip from "./CitationChip.vue"

const props = defineProps<{
  trackId: string
  startMs: number
  endMs: number
  /** LLM-generated snippet caption from the marker. Used by the chip
   *  fallback; the full card shows the transcript text instead. */
  caption?: string
}>()

const { t } = useI18n()
const app = useShruti()
const appLanguage = useAppLanguage()
const dictionaries = useDictionariesStore()
const citeTranscriptStore = useCiteTranscriptStore()
const purchases = usePurchasesStore()
const paywall = usePaywallStore()
const studioHandoff = useStudioHandoffStore()
const toast = useToast()
const { addToPlaylist } = useAddToPlaylist()
const { saveCitation } = useChatActions()

const track = ref<Track | null>(null)
const author = ref<Author | null>(null)
const actionSheetOpen = ref(false)
const savingNote = ref(false)
/** Toggles the card text between the (shown) translation and the
 *  original; only meaningful when the snippet is a machine translation. */
const showOriginal = ref(false)

/** Transcript snippet pushed by the server ahead of the marker. Null
 *  until it lands (or forever for pre-feature history) → chip fallback. */
const snippet = computed(() =>
  citeTranscriptStore.getEntry(props.trackId, props.startMs, props.endMs)
)
const snippetText = computed<string | null>(() => snippet.value?.text ?? null)
/** True when the shown text is a machine translation with an original to
 *  flip to. */
const isMt = computed<boolean>(() => !!snippet.value?.mt && !!snippet.value?.textOriginal)
/** What the card renders: the original when toggled (and available),
 *  otherwise the shown (possibly translated) text. */
const displayText = computed<string>(() => {
  const s = snippet.value
  if (!s) return ""
  return showOriginal.value && s.textOriginal ? s.textOriginal : s.text
})

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
 * Passed as a computed so the player reads `sourceKey` fresh once the
 * track (hence `audioPath`) resolves — see the useExcerptWaveform getter.
 */
const playerRef = computed(() => ({
  noteId: citationExcerptId({ trackId: props.trackId, startMs: props.startMs, endMs: props.endMs }),
  trackId: props.trackId,
  sourceKey: audioPath.value,
  timeStart: props.startMs,
  timeEnd: props.endMs,
}))

const trackTitle = computed<string>(() =>
  track.value ? (resolveTrackTitle(track.value, appLanguage.value) ?? "") : ""
)

const authorName = computed<string>(
  () => resolveLocalizedName(author.value, appLanguage.value) ?? ""
)

const referenceLabel = computed<string>(() => {
  const first = track.value?.references?.[0]
  if (!first) return ""
  return formatReference(first, dictionaries.sourcesById, appLanguage.value)
})

const trackDate = computed<string>(() => track.value?.date || "")

const actionSheetHeader = computed<string>(() => trackTitle.value)

interface CardActionSheetButton {
  readonly text: string
  readonly role?: "cancel" | "destructive"
  readonly handler: () => void
}

const actionSheetButtons = computed<readonly CardActionSheetButton[]>(() => [
  {
    text: t("chat.citationSaveAsNote"),
    handler: (): void => {
      void onSaveAsNote()
    },
  },
  {
    text: t("chat.citationOpenInStudio"),
    handler: (): void => {
      void onOpenInStudio()
    },
  },
  {
    text: t("chat.citationAddLectureToPlaylist"),
    handler: (): void => {
      void onAddToPlaylist()
    },
  },
  {
    text: t("app.cancel"),
    role: "cancel",
    handler: (): void => undefined,
  },
])

function onOpenActions(): void {
  actionSheetOpen.value = true
}

async function onAddToPlaylist(): Promise<void> {
  try {
    await addToPlaylist(props.trackId)
    await toast.info(t("chat.citationAddedToPlaylist"))
  } catch (err) {
    console.warn("[citation-card] add to playlist failed", err)
    await toast.error(t("chat.citationAddFailed"))
  }
}

function onOpenInStudio(): void {
  if (!purchases.isSubscribed) {
    paywall.requestOpen("notesStudio")
    return
  }
  studioHandoff.setPending({
    kind: "citation",
    trackId: props.trackId,
    startMs: props.startMs,
    endMs: props.endMs,
    caption: props.caption ?? "",
  })
  void router.push("/tabs/studio")
}

async function onSaveAsNote(): Promise<void> {
  if (savingNote.value) return
  savingNote.value = true
  try {
    await saveCitation({
      trackId: props.trackId,
      startMs: props.startMs,
      endMs: props.endMs,
      caption: props.caption ?? "",
      // Card mode only renders when the snippet text is known; pass it so
      // the note body is the real fragment, not a re-fetch / the caption.
      ...(snippetText.value ? { text: snippetText.value } : {}),
    })
  } finally {
    savingNote.value = false
  }
}

async function loadMetadata(): Promise<void> {
  try {
    const repos = app.repositories()
    const t0 = await repos.tracks.getById(props.trackId as TrackId)
    track.value = t0 ?? null
    author.value =
      t0 && t0.authorId ? ((await repos.authors.getById(t0.authorId as AuthorId)) ?? null) : null
  } catch (err) {
    console.warn("[citation-card] metadata load failed", err)
  }
}

onMounted(() => {
  // Hydrate the persisted snippet cache so reopened chat history shows
  // cards (not chips) for previously-streamed citations.
  void citeTranscriptStore.hydrate()
  // Sources are needed to format the shloka reference, like the Notes
  // list does; one-shot full load, cached across the session.
  void dictionaries.ensureLoaded()
})

watch(
  () => props.trackId,
  () => {
    track.value = null
    author.value = null
    void loadMetadata()
  },
  { immediate: true }
)
</script>

<style scoped>
/* Chip fallback on its own line — block so the prose after the citation
 * starts on a new line, like the card / quote. */
.citation-chip-line {
  display: block;
  margin: 6px 0;
}

/* Quote-style frame, matching the chat blockquote: left accent bar +
 * soft primary tint. Block-level so it sits between prose tokens like
 * the verse card. */
.citation-card {
  position: relative;
  display: block;
  margin: 10px 0;
  padding: 0;
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  border-radius: 4px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  --excerpt-body-padding: 8px 12px 10px;
}

.citation-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 3px;
  background: var(--ion-color-primary);
  z-index: 2;
}

.citation-card :deep(.notes-inline-player) {
  margin-bottom: 0;
  border-radius: 4px 4px 0 0;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

/* Muted machine-translation caption, BELOW and OUTSIDE the quote frame,
 * right-aligned — reads as a note about the card, not quoted text. */
.cite-mt-line {
  display: flex;
  justify-content: flex-end;
  align-items: baseline;
  gap: 6px;
  margin: 4px 2px 10px;
  font-size: 11px;
  color: var(--ion-color-medium);
}
.cite-mt-badge {
  font-style: italic;
}
.cite-mt-toggle {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-color-primary);
  font-size: 11px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
</style>
