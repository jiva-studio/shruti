<template>
  <IonModal :is-open="open" class="track-sheet" @did-dismiss="onDismiss">
    <IonButton class="close-button" fill="clear" :aria-label="t('app.close')" @click="onDismiss">
      <IconX slot="icon-only" :size="16" />
    </IonButton>
    <div class="sheet-header">
      <div class="sheet-heading">
        <h2 class="sheet-title">{{ title }}</h2>
        <p v-if="author" class="author">{{ author }}</p>
      </div>
    </div>
    <IonContent ref="contentRef">
      <div class="sheet-body">
        <div v-if="topicChips.length" class="topic-chips">
          <span v-for="(name, i) in visibleChips" :key="i" class="topic-chip">
            <IconHash :size="11" class="chip-hash" />
            {{ name }}
          </span>
          <span v-if="overflowCount" class="topic-chip more">+{{ overflowCount }}</span>
        </div>
        <p v-if="description" class="description">{{ description }}</p>
        <LectureOutline v-if="chapters.length" :chapters="chapters" />
      </div>
      <SimilarTracksRow v-if="track" :track="track" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <div class="sheet-actions">
        <IonButton fill="clear" class="act share-btn" @click="onShare">
          <IconShare slot="start" :size="18" />
          {{ t("search.actions.share") }}
          <span v-if="!isSubscribed" class="pro">PRO</span>
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
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonContent, IonFooter, IonModal } from "@ionic/vue"
import { IconHash, IconPlaylistAdd, IconReload, IconShare, IconX } from "@tabler/icons-vue"
import { loadTrackDetail } from "@usecases/playback/loadTrackDetail.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useAddToPlaylist } from "@lectorium/composables/useAddToPlaylist.js"
import { useShareTrack } from "@lectorium/composables/useShareTrack.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useTrackSheetStore } from "@lectorium/stores/useTrackSheetStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import LectureOutline from "@ui/components/LectureOutline.vue"
import SimilarTracksRow from "@lectorium/components/SimilarTracksRow.vue"

const { t } = useI18n()
const app = useLectorium()
const appLanguage = useAppLanguage()
const libraryLanguages = useLibraryLanguages()
const sheet = useTrackSheetStore()
const dictionaries = useDictionariesStore()
const purchases = usePurchasesStore()
const paywall = usePaywallStore()
const overlays = useOverlaysStore()
const downloads = useDownloadStore()
const playlist = usePlaylistStore()
const { addToPlaylist } = useAddToPlaylist()
const { presentShareMenu } = useShareTrack()

const track = ref<Track | null>(null)
const authorEntity = ref<Author | null>(null)
const selectedLanguage = ref<LanguageCode | null>(null)

const open = computed(() => sheet.trackId !== null)
const isSubscribed = computed(() => purchases.isSubscribed)
// A failed/stuck download turns the primary button into a "Download again"
// retry — the row no longer retries on tap, so the sheet is where the user
// recovers from a download error.
const downloadFailed = computed(
  () => sheet.trackId !== null && downloads.getState(sheet.trackId as TrackId) === "failed"
)
// The "Add to playlist" action is disabled once the track is already there —
// the playlist usecase rejects a duplicate add, so there is nothing to do. A
// failed download takes priority (the track is in the playlist but still needs
// a retry), so it stays actionable as "Download again".
const alreadyInPlaylist = computed(() => sheet.trackId !== null && playlist.hasTrack(sheet.trackId))
const primaryActionLabel = computed(() => {
  if (downloadFailed.value) return t("search.actions.downloadAgain")
  if (alreadyInPlaylist.value) return t("search.actions.alreadyInPlaylist")
  return t("search.actions.addToPlaylist")
})

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
  return resolveTrackTitle(track.value, contentLang.value) ?? track.value.id
})

const author = computed(() => {
  if (!authorEntity.value) return null
  return resolveLocalizedName(authorEntity.value, appLanguage.value) ?? null
})

const variant = computed(
  () => track.value?.variants.find((v) => v.language === effectiveLang.value) ?? null
)
const description = computed(() => variant.value?.description ?? null)
const chapters = computed<readonly TrackOutlineChapter[]>(() => variant.value?.outline ?? [])

const VISIBLE_CHIPS = 4
const topicChips = computed<string[]>(() =>
  (track.value?.topicIds ?? []).map((id) => dictionaries.topicShortNamesById.get(id) ?? id)
)
const visibleChips = computed(() => topicChips.value.slice(0, VISIBLE_CHIPS))
const overflowCount = computed(() => Math.max(0, topicChips.value.length - VISIBLE_CHIPS))

const contentRef = ref<InstanceType<typeof IonContent> | null>(null)

watch(
  () => sheet.trackId,
  async (id) => {
    if (id === null) {
      track.value = null
      authorEntity.value = null
      selectedLanguage.value = null
      overlays.actionSheetOpen = false
      return
    }
    overlays.actionSheetOpen = true
    void app.haptics.impact("light")
    void dictionaries.ensureLoaded()
    const repos = app.repositories()
    const detail = await loadTrackDetail(
      { trackId: id },
      { tracks: repos.tracks, authors: repos.authors, transcripts: repos.transcripts }
    )
    // A newer present() may have superseded this load — drop the stale result.
    if (!detail.ok || sheet.trackId !== id) return
    track.value = detail.value.track
    authorEntity.value = detail.value.author
    // Default the shown transcript to the track's content language (a library
    // language it has), else its first available — the user can still switch.
    const preferred = preferredContentLanguage(
      detail.value.track,
      libraryLanguages.value,
      appLanguage.value
    )
    selectedLanguage.value =
      detail.value.availableLanguages.find((l: LanguageCode) => l === preferred) ??
      detail.value.availableLanguages[0] ??
      null
    // Opening a similar lecture swaps content in the same sheet — reset scroll
    // so the user starts at the top of the new lecture rather than mid-page.
    void contentRef.value?.$el?.scrollToTop?.(300)
  }
)

function onDismiss(): void {
  sheet.close()
}

function onPrimaryAction(): void {
  if (downloadFailed.value) {
    onDownloadAgain()
    return
  }
  onAddToPlaylist()
}

function onAddToPlaylist(): void {
  const id = sheet.trackId
  if (!id) return
  void addToPlaylist(id)
  sheet.close()
}

function onDownloadAgain(): void {
  const id = sheet.trackId
  if (!id) return
  // Re-run the audio download for the first variant that has one;
  // `ensureDownloaded` takes the retry path off the "failed" state.
  const audioVariant = track.value?.variants.find((v) => v.audio)
  if (audioVariant?.audio) {
    void downloads.ensureDownloaded(id as TrackId, audioVariant.audio.path)
  }
  sheet.close()
}

function onShare(): void {
  const id = sheet.trackId
  if (!id) return
  // Pro feature — non-subscribers get the paywall; subscribers get the
  // per-format share menu (PDF / text / audio).
  if (!purchases.isSubscribed) {
    sheet.close()
    paywall.requestOpen("shareTranscript")
    return
  }
  void presentShareMenu(id)
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

.topic-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px 6px;
  margin: 0 0 16px;
}

.topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  line-height: 1.3;
  color: var(--ion-color-medium-shade, #666);
  background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}

.chip-hash {
  flex: none;
  opacity: 0.55;
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

.sheet-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px calc(10px + var(--ion-safe-area-bottom, 0px));
  background: var(--ion-background-color, #fff);
  border-top: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.08));
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

.pro {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  background: var(--ion-color-warning, #ffc409);
  color: #1f1300;
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
