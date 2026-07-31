<template>
  <IonModal :is-open="open" class="track-sheet" @did-dismiss="onDismiss">
    <IonButton class="close-button" fill="clear" :aria-label="t('app.close')" @click="onDismiss">
      <IconX slot="icon-only" :size="16" />
    </IonButton>
    <div class="sheet-header">
      <div class="sheet-heading">
        <h2 class="sheet-title">{{ title }}</h2>
        <p v-if="author" class="author">{{ author }}</p>
        <p v-if="metaLine" class="meta">{{ metaLine }}</p>
      </div>
    </div>
    <IonContent ref="contentRef">
      <div class="sheet-body">
        <TopicChips :names="topicNames" />
        <p v-if="description" class="description">{{ description }}</p>
        <LectureOutline v-if="chapters.length" :chapters="chapters" />
      </div>
      <SimilarTracksRow v-if="track" :track="track" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <div class="sheet-actions">
        <IonButton v-if="isLibraryItem" fill="clear" class="act remove-btn" @click="onRemove">
          <IconTrash slot="start" :size="18" />
          {{ t("library.remove") }}
        </IonButton>
        <IonButton fill="clear" class="act share-btn" @click="onShare">
          <IconShare slot="start" :size="18" />
          {{ t("search.actions.share") }}
        </IonButton>
        <IonButton
          class="act add-btn"
          :disabled="alreadyInPlaylist && !downloadFailed"
          @click="onPrimaryAction"
        >
          <IconReload v-if="downloadFailed" slot="start" :size="18" />
          <IconPlaylistAdd v-else slot="start" :size="18" />
          {{ primaryActionLabel }}
        </IonButton>
      </div>
    </IonFooter>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonContent, IonFooter, IonModal } from "@ionic/vue"
import { IconPlaylistAdd, IconReload, IconShare, IconTrash, IconX } from "@tabler/icons-vue"
import type { LanguageCode } from "@lib/domain/core.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveLocalizedNameOrEmpty,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { formatTrackDate } from "@lectorium/composables/formatTrackDate.js"
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

const { t } = useI18n()
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

// Location + date read as a single label line under the author. Location is
// resolved from the shared dictionaries cache, and the date is formatted to
// match the track lists / chat rows.
const metaLine = computed(() => {
  if (!track.value) return ""
  const parts: string[] = []
  const location = track.value.locationId
    ? dictionaries.locationsById.get(track.value.locationId)
    : null
  const loc =
    resolveLocalizedNameOrEmpty(location, appLanguage.value) || locationRaw.value?.trim() || ""
  if (loc) parts.push(loc)
  if (track.value.date) parts.push(formatTrackDate(track.value.date, appLanguage.value))
  return parts.join(" · ")
})

const variant = computed(
  () => track.value?.variants.find((v) => v.language === effectiveLang.value) ?? null
)
const description = computed(() => variant.value?.description ?? null)
const chapters = computed<readonly TrackOutlineChapter[]>(() => variant.value?.outline ?? [])

const topicNames = computed<string[]>(() =>
  (track.value?.topicIds ?? []).map((id) => dictionaries.topicShortNamesById.get(id) ?? id)
)

function onDismiss(): void {
  sheet.close()
}
</script>

<style scoped>
.sheet-header {
  padding: 14px 16px 10px;
  /* leave room for the absolutely-positioned close button */
  padding-right: 52px;
  background: var(--ion-background-color, #fff);
}

.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ion-text-color, #222);
}

.sheet-body {
  padding: 4px var(--ion-padding, 16px) 16px;
}

.sheet-heading {
  flex: 1;
  min-width: 0;
}

.close-button {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 10;
  width: 26px;
  height: 26px;
  min-height: 26px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  --padding-start: 0;
  --padding-end: 0;
  --border-radius: 50%;
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.1));
  --color: var(--ion-color-medium, #777);
}

.close-button::part(native) {
  width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-title {
  margin: 4px 0 2px;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
}

.author {
  margin: 0;
  font-size: 14px;
  color: var(--ion-color-medium, #777);
}

.meta {
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--ion-color-medium, #777);
}

.sheet-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px calc(10px + var(--ion-safe-area-bottom, 0px));
  background: var(--ion-background-color, #fff);
  border-top: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.08));
}

/* Quiet destructive action in the same button stack — a user-added lecture can
   be taken out of the personal library from its own sheet. Matches the share
   button's soft chrome, tinted danger. */
.remove-btn {
  --background: rgba(var(--ion-color-danger-rgb), 0.1);
  --background-hover: rgba(var(--ion-color-danger-rgb), 0.16);
  --color: var(--ion-color-danger);
}

.act {
  position: relative;
  margin: 0;
  --padding-start: 0;
  --padding-end: 0;
  --box-shadow: none;
}

.act [slot="start"] {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
}

.share-btn {
  position: relative;
  /* Soft, light secondary button (no heavy outline) — sits quieter than the
     solid "add to playlist" primary action below it. */
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
  --color: var(--ion-color-medium, #777);
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
</style>
