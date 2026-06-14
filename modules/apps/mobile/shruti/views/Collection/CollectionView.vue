<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ detail?.name ?? "" }}</IonTitle>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true">
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
  </IonPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { TracksList, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { useShruti } from "@shruti/shruti.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useTrackUiStateMapper } from "@shruti/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@shruti/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@lib/application"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { CollectionDetail } from "@infra/repositories/sql/index.js"

const props = defineProps<{ id: string }>()

const { t } = useI18n()
const app = useShruti()
const playlist = usePlaylistStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()
const appLanguage = useAppLanguage()

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
    console.warn("[collection] load failed", err)
    detail.value = null
    tracks.value = []
  }
}

watch(
  () => [props.id, appLanguage.value] as const,
  ([id, locale]) => void load(id, locale),
  { immediate: true }
)

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
    if (!result.ok) void toast.error(t("search.collections.addError"))
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

.add-button {
  --box-shadow: none;
}
</style>
