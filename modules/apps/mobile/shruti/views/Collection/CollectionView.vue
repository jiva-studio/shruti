<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ detail?.name ?? "" }}</IonTitle>
        <IonButtons slot="end">
          <IonButton
            class="no-ripple"
            :disabled="adding || !detail || detail.trackIds.length === 0"
            :aria-label="t('search.collections.addAll')"
            @click="onAdd"
          >
            <IconPlaylistAdd :size="24" />
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <p v-if="detail?.description" class="description">{{ detail.description }}</p>
      <TracksList :rows="rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  alertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconPlaylistAdd } from "@tabler/icons-vue"
import { FlatHeader } from "@ui/primitives/index.js"
import { TracksList } from "@ui/components/tracks/list/index.js"
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

const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })

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
  const count = detail.value?.trackIds.length ?? 0
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
</style>
