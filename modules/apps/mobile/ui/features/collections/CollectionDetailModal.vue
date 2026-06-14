<template>
  <IonModal
    class="collection-dialog"
    :is-open="open"
    :breakpoints="[0, 0.75, 1]"
    :initial-breakpoint="0.75"
    @did-dismiss="onDismiss"
  >
    <Header>
      <IonToolbar>
        <IonTitle>{{ detail?.name ?? "" }}</IonTitle>
        <IonButtons slot="end">
          <IonButton shape="round" size="small" @click="open = false">
            {{ t("app.close") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </Header>

    <IonContent>
      <p v-if="detail?.description" class="description">{{ detail.description }}</p>
      <TracksList :rows="rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
      <div class="actions">
        <IonButton
          class="add-button"
          expand="block"
          :disabled="adding || !detail || detail.trackIds.length === 0"
          @click="onAdd"
        >
          {{ t("search.collections.addAll") }}
        </IonButton>
      </div>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonButtons, IonContent, IonModal, IonTitle, IonToolbar } from "@ionic/vue"
import { Header } from "@ui/primitives/index.js"
import { TracksList, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@lib/application"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { CollectionDetail } from "@infra/repositories/sql/index.js"

/**
 * Collection-detail sheet (75% breakpoint) opened from the Search carousel:
 * header with the collection name, the ordered list of its tracks, and a footer
 * "Add collection". Tapping a track opens the standard per-track action sheet
 * (add / download / PDF / …) — same as the library — rather than playing it.
 */
const open = defineModel<boolean>("open", { required: true, default: false })

const props = defineProps<{
  collectionId: string | null
  locale: string
}>()

const { t } = useI18n()
const app = useLectorium()
const playlist = usePlaylistStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()

const detail = ref<CollectionDetail | null>(null)
const tracks = ref<readonly Track[]>([])
const adding = ref(false)

const rows = computed<readonly UiTrackRow[]>(() => tracks.value.map((tr) => mapper.toUiRow(tr)))

async function load(id: string, locale: string): Promise<void> {
  detail.value = null
  tracks.value = []
  try {
    const repos = app.repositories()
    const d = await repos.collections.getCollection(id, locale)
    detail.value = d
    if (!d || d.trackIds.length === 0) return
    const byId = await repos.tracks.getByIds([...d.trackIds])
    tracks.value = d.trackIds
      .map((tid) => byId.get(tid))
      .filter((tr): tr is Track => tr !== undefined)
  } catch (err) {
    console.warn("[collection-detail] load failed", err)
    detail.value = null
    tracks.value = []
  }
}

watch(
  () => [open.value, props.collectionId] as const,
  ([isOpen, id]) => {
    if (isOpen && id) void load(id, props.locale)
  },
  { immediate: true }
)

function onDismiss(): void {
  open.value = false
}

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

async function onAdd(): Promise<void> {
  if (!detail.value || detail.value.trackIds.length === 0) return
  adding.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: [...detail.value.trackIds] },
      { playlist: { add: (id) => playlist.add(id) } }
    )
    if (!result.ok) {
      void toast.error(t("search.collections.addError"))
    } else {
      open.value = false
    }
  } catch {
    void toast.error(t("search.collections.addError"))
  } finally {
    adding.value = false
  }
}
</script>

<style scoped>
.description {
  margin: 0;
  padding: 12px 16px 4px;
  font-size: 14px;
  line-height: 1.45;
  color: var(--ion-color-medium-shade);
}

.actions {
  padding: 8px 12px 16px;
}

/* Flat add button — no Material elevation. */
.add-button {
  --box-shadow: none;
}
</style>

<style>
/* Flatten the Material elevation/hairline under the header so the sheet reads
   flat (matches HelpDialog). */
.collection-dialog ion-header,
.collection-dialog ion-header::after {
  box-shadow: none !important;
  background-image: none;
}
.collection-dialog ion-header::after {
  display: none;
}
</style>
