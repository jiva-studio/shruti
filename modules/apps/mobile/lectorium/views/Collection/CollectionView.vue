<script setup lang="ts">
import { computed, ref, toRef } from "vue"
import { useI18n } from "vue-i18n"
import { alertController, IonContent, IonPage, IonSpinner } from "@ionic/vue"
import { PageSticker } from "@ui/primitives/index.js"
import { resolveAssetUrl } from "@lectorium/services/regionsRegistry.js"
import TrackRowsList from "@lectorium/views/components/TrackRowsList.vue"
import CollectionHero from "./components/CollectionHero.vue"
import CollectionHeroToolbar from "./components/CollectionHeroToolbar.vue"
import { useCollectionDetail, type CollectionKind } from "./useCollectionDetail.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@usecases"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"

// One detail page for any track-bearing entity: a collection or a recommender
// topic. `kind` selects how the header and the track ids load; the chrome is
// shared.
const props = defineProps<{ id: string; kind?: CollectionKind }>()

const { t } = useI18n()
const playlist = usePlaylistStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()

const kind = computed<CollectionKind>(() => props.kind ?? "collection")
const { title, description, coverKey, trackIds, tracks, loading, error } = useCollectionDetail(
  toRef(props, "id"),
  kind
)

const adding = ref(false)
const coverUrl = computed(() => (coverKey.value ? resolveAssetUrl(coverKey.value) : undefined))
// Not numbered: on this page the running order is already the list order.
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

const sticker = computed<{ header?: string; message: string } | null>(() => {
  if (error.value === "missing") {
    return {
      header: t("search.collections.missingTitle"),
      message: t("search.collections.missingMessage"),
    }
  }
  if (error.value === "failed") return { message: t("search.collections.loadFailed") }
  return null
})

const HERO_HEIGHT = 240
const scrollTop = ref(0)
function onScroll(e: CustomEvent<{ scrollTop: number }>): void {
  scrollTop.value = e.detail.scrollTop
}

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

async function onAdd(): Promise<void> {
  const count = trackIds.value.length
  if (count === 0) return
  const alert = await alertController.create({
    header: t("search.collections.addAll"),
    message: t("search.collections.addConfirm", { count }, count),
    buttons: [
      { text: t("app.cancel"), role: "cancel" },
      { text: t("app.ok"), role: "confirm", handler: () => void performAdd() },
    ],
  })
  await alert.present()
}

async function performAdd(): Promise<void> {
  if (trackIds.value.length === 0) return
  adding.value = true
  // A topic shelf is not a collection, so its tracks stay standalone.
  const sourceCollectionId = kind.value === "collection" ? props.id : null
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...trackIds.value] },
      { playlist: { add: (id) => playlist.add(id, sourceCollectionId) } }
    )
    if (!result.ok) void toast.error(t("search.collections.addError"))
  } catch {
    void toast.error(t("search.collections.addError"))
  } finally {
    adding.value = false
  }
}
</script>

<template>
  <IonPage>
    <CollectionHeroToolbar
      :title="title"
      :scroll-top="scrollTop"
      :hero-height="HERO_HEIGHT"
      :flat="error !== null"
      :add-disabled="adding || trackIds.length === 0"
      :add-label="t('search.collections.addAll')"
      @add="onAdd"
    />

    <IonContent :fullscreen="true" :scroll-events="true" @ionScroll="onScroll">
      <!-- With nothing loaded the hero would be a grey block above a message. -->
      <CollectionHero
        v-if="!sticker"
        :title="title"
        :cover-url="coverUrl"
        :scroll-top="scrollTop"
        :height="HERO_HEIGHT"
      />

      <p v-if="description" class="description">{{ description }}</p>

      <div v-if="loading" class="detail-loading">
        <IonSpinner name="crescent" />
      </div>
      <PageSticker
        v-else-if="sticker"
        data-testid="collection-error"
        :header="sticker.header"
        :message="sticker.message"
      />
      <TrackRowsList v-else :rows="rows" @select="onSelectTrack" />
    </IonContent>
  </IonPage>
</template>

<style scoped>
/* No overscroll stretch: pulling past the top would balloon the pinned hero. */
ion-content::part(scroll) {
  overscroll-behavior-y: none;
}

.description {
  margin: 0;
  padding: 14px 16px 4px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ion-color-medium-shade);
}

.detail-loading {
  display: flex;
  justify-content: center;
  padding: 32px 0;
  color: var(--ion-color-medium);
}
</style>
