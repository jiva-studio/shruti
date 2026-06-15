<template>
  <IonModal :is-open="open" class="track-sheet" @did-dismiss="onDismiss">
    <IonContent class="ion-padding">
      <div class="sheet-header">
        <div class="sheet-heading">
          <h2 class="sheet-title">{{ title }}</h2>
          <p v-if="author" class="author">{{ author }}</p>
        </div>
        <IonButton
          class="close-button"
          fill="clear"
          :aria-label="t('app.close')"
          @click="onDismiss"
        >
          <IconX slot="icon-only" :size="16" />
        </IonButton>
      </div>
      <LectureOverview class="overview" :description="description" :chapters="chapters" />
    </IonContent>

    <IonFooter class="ion-no-border">
      <div class="sheet-actions">
        <IonButton fill="clear" class="act share-btn" @click="onShare">
          {{ t("search.actions.share") }}
          <span v-if="!isSubscribed" class="pro">PRO</span>
        </IonButton>
        <IonButton class="act" @click="onAddToPlaylist">
          <IconPlaylistAdd slot="start" :size="18" />
          {{ t("search.actions.addToPlaylist") }}
        </IonButton>
      </div>
    </IonFooter>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonContent, IonFooter, IonModal } from "@ionic/vue"
import { IconPlaylistAdd, IconX } from "@tabler/icons-vue"
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
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"
import LectureOverview from "@ui/components/LectureOverview.vue"

const { t } = useI18n()
const app = useShruti()
const appLanguage = useAppLanguage()
const sheet = useTrackSheetStore()
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

// Title + author follow the UI language (like the track list / mapper) so the
// author shows its English name on an English UI. resolveTrackTitle still
// falls back to the only existing title when there's no UI-language variant.
const title = computed(() => {
  if (!track.value) return ""
  return resolveTrackTitle(track.value, appLanguage.value) ?? track.value.id
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
  sheet.close()
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
</script>

<style scoped>
.sheet-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.overview {
  margin-top: 16px;
}

.sheet-heading {
  flex: 1;
  min-width: 0;
}

.close-button {
  flex: none;
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
  margin: 0;
  --box-shadow: none;
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
