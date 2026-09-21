<script setup lang="ts">
import { computed, ref, useTemplateRef } from "vue"
import { useI18n } from "vue-i18n"
import { useRouter } from "vue-router"
import { IonContent, IonFooter, IonModal } from "@ionic/vue"
import type { LanguageCode } from "@lib/domain/core.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { formatTrackDate } from "@lib/domain/services/trackDate.js"
import { formatListeningDuration } from "@lectorium/composables/formatListeningDuration.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useTrackSheetDetail } from "@lectorium/composables/useTrackSheetDetail.js"
import { useTrackSheetActions } from "@lectorium/composables/useTrackSheetActions.js"
import { useTrackSheetStore } from "@lectorium/stores/useTrackSheetStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useLibraryStore } from "@lectorium/stores/useLibraryStore.js"
import LectureOutline from "@ui/components/LectureOutline.vue"
import SimilarTracksRow from "@lectorium/components/SimilarTracksRow.vue"
import TopicChips from "@lectorium/components/TopicChips.vue"
import TrackSheetActions from "@lectorium/components/TrackSheetActions.vue"
import TrackSheetCollectionRow from "@lectorium/components/TrackSheetCollectionRow.vue"
import TrackSheetHeader from "@lectorium/components/TrackSheetHeader.vue"
import { useElementHeight } from "@lectorium/composables/useElementHeight.js"
import { useTrackSheetCollections } from "@lectorium/composables/useTrackSheetCollections.js"

const { t } = useI18n()
const router = useRouter()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
const sheet = useTrackSheetStore()
const dictionaries = useDictionariesStore()
const library = useLibraryStore()

// The personal-library item backing this track, if any (matched by content
// hash). Present only for a user-added lecture — a corpus track has none, so
// the "Remove from My library" action stays hidden for it.
const libraryItem = computed(() =>
  sheet.trackId ? library.items.find((i) => i.trackId === sheet.trackId) : undefined
)
const isLibraryItem = computed(() => libraryItem.value !== undefined)

async function onRemove(): Promise<void> {
  const item = libraryItem.value
  if (!item) return
  await library.remove(item.id)
  onDismiss()
}

const contentRef = ref<InstanceType<typeof IonContent> | null>(null)

// Both bars float over the scroll, so the content has to reserve their height
// itself. Measured rather than assumed: the title runs to one, two or three
// lines, and the footer grows a third button for a library item.
const headerComp = useTemplateRef<{ $el: HTMLElement }>("headerComp")
const footerComp = useTemplateRef<{ $el: HTMLElement }>("footerComp")
const headerHeight = useElementHeight(computed(() => headerComp.value?.$el ?? null))
const footerHeight = useElementHeight(computed(() => footerComp.value?.$el ?? null))

const contentInsets = computed(() => ({
  "--padding-top": `${headerHeight.value}px`,
  "--padding-bottom": `${footerHeight.value}px`,
}))

// Opening a similar lecture swaps content in the same sheet — reset scroll so
// the user starts at the top of the new lecture rather than mid-page.
const { track, authorEntity, authorRaw, locationRaw, selectedLanguage } = useTrackSheetDetail({
  onAfterLoad: () => void contentRef.value?.$el?.scrollToTop?.(300),
})
const { downloadFailed, alreadyInPlaylist, primaryActionLabel, onPrimaryAction, onShare } =
  useTrackSheetActions(track)

const open = computed(() => sheet.trackId !== null)

// Content language for this track: the library language it actually has, so the
// title + transcript match the language the track was surfaced in. Falls back to
// the UI language (and resolveTrackTitle then to the only existing variant).
const contentLang = computed<LanguageCode>(
  () =>
    (track.value
      ? preferredContentLanguage(track.value, libraryLanguages.value, appLanguage.value)
      : undefined) ?? appLanguage.value
)

const effectiveLang = computed<LanguageCode>(() => selectedLanguage.value ?? contentLang.value)

// Title follows the content language; the author NAME is a label and follows the
// UI language.
const title = computed(() => {
  if (!track.value) return ""
  // Never surface the content-hash id as a title — an ingested lecture whose
  // metadata hasn't resolved shows the neutral placeholder, like the card.
  return resolveTrackTitle(track.value, contentLang.value) || t("library.untitled")
})

const author = computed(() => {
  if (authorEntity.value) return resolveLocalizedName(authorEntity.value, appLanguage.value) ?? null
  return authorRaw.value?.trim() || null
})

// Location + date + length read as a single label line under the author.
// Location is resolved from the shared dictionaries cache, and the date and
// length are formatted to match the track lists / chat rows.
const metaParts = computed<readonly { text: string; shrinkable: boolean }[]>(() => {
  if (!track.value) return []
  const parts: { text: string; shrinkable: boolean }[] = []
  const location = track.value.locationId
    ? dictionaries.locationsById.get(track.value.locationId)
    : null
  const loc =
    resolveLocalizedNameOrEmpty(location, appLanguage.value) || locationRaw.value?.trim() || ""
  if (loc) parts.push({ text: loc, shrinkable: true })
  if (track.value.date) {
    parts.push({ text: formatTrackDate(track.value.date, appLanguage.value), shrinkable: false })
  }
  // 0 means no playable audio — say nothing rather than "0m".
  const ms = maxAudioDurationMs(track.value)
  if (ms > 0) parts.push({ text: formatListeningDuration(ms / 1000, t), shrinkable: false })
  return parts
})

const variant = computed(
  () => track.value?.variants.find((v) => v.language === effectiveLang.value) ?? null
)
const description = computed(() => variant.value?.description ?? null)
const chapters = computed<readonly TrackOutlineChapter[]>(() => variant.value?.outline ?? [])

const topicNames = computed<string[]>(() =>
  (track.value?.topicIds ?? []).map((id) => dictionaries.topicShortNamesById.get(id) ?? id)
)

const partOf = useTrackSheetCollections(() => sheet.trackId, effectiveLang)

function onOpenCollection(id: string): void {
  sheet.close()
  void router.push({ name: "collection", params: { id } })
}

function onDismiss(): void {
  sheet.close()
}
</script>

<template>
  <IonModal :is-open="open" class="track-sheet" @did-dismiss="onDismiss">
    <TrackSheetHeader
      ref="headerComp"
      :title="title"
      :author="author"
      :meta-parts="metaParts"
      @close="onDismiss"
    />
    <IonContent ref="contentRef" :style="contentInsets">
      <div class="sheet-body">
        <TopicChips :names="topicNames" />
        <TrackSheetCollectionRow
          v-for="c in partOf"
          :key="c.id"
          :collection="c"
          @open="onOpenCollection"
        />
        <p v-if="description" class="description">{{ description }}</p>
        <LectureOutline v-if="chapters.length" :chapters="chapters" granularity="minute" />
      </div>
      <SimilarTracksRow v-if="track" :track="track" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <TrackSheetActions
        ref="footerComp"
        :is-library-item="isLibraryItem"
        :download-failed="downloadFailed"
        :add-disabled="alreadyInPlaylist && !downloadFailed"
        :primary-action-label="primaryActionLabel"
        @remove="onRemove"
        @share="onShare"
        @primary="onPrimaryAction"
      />
    </IonFooter>
  </IonModal>
</template>

<style scoped>
.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ion-text-color, #222);
}

.sheet-body {
  padding: 4px var(--ion-padding, 16px) 16px;
}
</style>

<style>
/* The modal is teleported to the app root, so these host vars must be GLOBAL —
   scoped styles never reach the moved <ion-modal>. A fixed-height, bottom-
   anchored card: IonContent scrolls, IonFooter stays pinned to the bottom. */
ion-modal.track-sheet {
  --width: 100%;
  --height: 92%;
  --border-radius: 16px 16px 0 0;
  align-items: flex-end;
}

/* Ionic gives the footer a row of its own below the content; overlaying it is
   what lets the list run underneath and fade out. Anchored to this modal —
   a bare `ion-footer` selector here is global CSS and disables pointer events
   on every other footer in the app (#1534). */
ion-modal.track-sheet ion-footer {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  background: transparent;
  pointer-events: none;
}

ion-modal.track-sheet ion-footer .sheet-actions > * {
  pointer-events: auto;
}
</style>
