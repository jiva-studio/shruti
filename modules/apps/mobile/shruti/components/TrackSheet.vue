<template>
  <IonModal
    :is-open="open"
    :initial-breakpoint="0.6"
    :breakpoints="[0, 0.6, 0.95]"
    class="track-sheet"
    @did-dismiss="onDismiss"
  >
    <IonHeader class="ion-no-border">
      <IonToolbar>
        <IonTitle class="sheet-title">{{ title }}</IonTitle>
        <IonButtons slot="end">
          <IonButton :aria-label="t('search.actions.addToPlaylist')" @click="onAddToPlaylist">
            <IconPlus :size="22" />
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>

    <IonContent class="ion-padding">
      <p v-if="author" class="author">{{ author }}</p>
      <LectureOverview :description="description" :chapters="chapters" @pick="onPickChapter" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <IonToolbar>
        <IonButton expand="block" class="share-btn" @click="onShare">
          {{ t("search.actions.share") }}
          <span v-if="!isSubscribed" class="pro">PRO</span>
        </IonButton>
      </IonToolbar>
    </IonFooter>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonModal,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconPlus } from "@tabler/icons-vue"
import { loadTrackDetail } from "@lib/application/loadTrackDetail.js"
import type { Author } from "@lib/domain/author.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useAddToPlaylist } from "@shruti/composables/useAddToPlaylist.js"
import { useShareTrack } from "@shruti/composables/useShareTrack.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { usePaywallStore } from "@shruti/stores/usePaywallStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"
import LectureOverview from "@ui/components/LectureOverview.vue"

const { t } = useI18n()
const app = useShruti()
const appLanguage = useAppLanguage()
const sheet = useTrackSheetStore()
const player = usePlayerStore()
const playlist = usePlaylistStore()
const purchases = usePurchasesStore()
const paywall = usePaywallStore()
const overlays = useOverlaysStore()
const { addToPlaylist } = useAddToPlaylist()
const { presentShareMenu } = useShareTrack()

const track = ref<Track | null>(null)
const authorEntity = ref<Author | null>(null)
const selectedLanguage = ref<LanguageCode | null>(null)

const open = computed(() => sheet.trackId !== null)
const isSubscribed = computed(() => purchases.isSubscribed)

const effectiveLang = computed<LanguageCode>(() => selectedLanguage.value ?? appLanguage.value)

const title = computed(() => {
  if (!track.value) return ""
  return resolveTrackTitle(track.value, effectiveLang.value) ?? track.value.id
})

const author = computed(() => {
  if (!authorEntity.value) return null
  return resolveLocalizedName(authorEntity.value, effectiveLang.value) ?? null
})

const variant = computed(
  () => track.value?.variants.find((v) => v.language === effectiveLang.value) ?? null
)
const description = computed(() => variant.value?.description ?? null)
const chapters = computed<readonly TrackOutlineChapter[]>(() => variant.value?.outline ?? [])

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
    const repos = app.repositories()
    const detail = await loadTrackDetail(
      { trackId: id },
      { tracks: repos.tracks, authors: repos.authors, transcripts: repos.transcripts }
    )
    // A newer present() may have superseded this load — drop the stale result.
    if (!detail.ok || sheet.trackId !== id) return
    track.value = detail.value.track
    authorEntity.value = detail.value.author
    selectedLanguage.value =
      detail.value.availableLanguages.find((l: LanguageCode) => l === appLanguage.value) ??
      detail.value.availableLanguages[0] ??
      null
  }
)

function onDismiss(): void {
  sheet.close()
}

function onAddToPlaylist(): void {
  const id = sheet.trackId
  if (!id) return
  void addToPlaylist(id)
}

function onShare(): void {
  const id = sheet.trackId
  if (!id) return
  // Pro feature — non-subscribers get the paywall; subscribers get the
  // per-format share menu (PDF / text / audio).
  if (!purchases.isSubscribed) {
    paywall.requestOpen("shareTranscript")
    return
  }
  void presentShareMenu(id)
}

async function onPickChapter(startMs: number): Promise<void> {
  if (!track.value) return
  const entry = playlist.getEntryByTrackId(track.value.id)
  await player.openTrack({
    track: track.value,
    preferredLanguage: effectiveLang.value,
    author: authorEntity.value,
    itemId: entry?.item.id,
    resumeFromMs: startMs,
  })
  sheet.close()
}
</script>

<style scoped>
.sheet-title {
  padding-inline: 0;
  font-size: 17px;
  font-weight: 600;
}

.author {
  margin: 0 0 14px;
  font-size: 14px;
  color: var(--ion-color-medium, #777);
}

.empty {
  margin: 8px 0 0;
  font-size: 14px;
  color: var(--ion-color-medium, #777);
}

.share-btn {
  margin: 0;
}

.pro {
  margin-inline-start: 8px;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  background: var(--ion-color-warning, #ffc409);
  color: #1f1300;
}
</style>
