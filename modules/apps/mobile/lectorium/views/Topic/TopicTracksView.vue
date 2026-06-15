<template>
  <IonPage>
    <FlatHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/search" />
        </IonButtons>
        <IonTitle>{{ topicName }}</IonTitle>
        <IonButtons slot="end">
          <IonButton
            class="no-ripple"
            :disabled="adding || tracks.length === 0"
            :aria-label="t('search.collections.addAll')"
            @click="onAdd"
          >
            <IconPlaylistAdd :size="24" />
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <TracksList :rows="rows" @select="onSelectTrack">
        <template #state="{ state, progressPct }">
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TracksList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
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
import { useLectorium } from "@lectorium/lectorium.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import { useTrackActionSheet } from "@lectorium/composables/useTrackActionSheet.js"
import { addTracksToPlaylist } from "@lib/application"
import { useToast } from "@kit/composables"
import type { TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"

const props = defineProps<{ topicId: string }>()

const { t } = useI18n()
const app = useLectorium()
const playlist = usePlaylistStore()
const dictionaries = useDictionariesStore()
const toast = useToast()
const mapper = useTrackUiStateMapper()
const trackActions = useTrackActionSheet()

const tracks = ref<readonly Track[]>([])
const adding = ref(false)
const rows = mapper.mapRows(() => tracks.value, { context: "discovery" })
const topicName = computed(() => dictionaries.topicNamesById.get(props.topicId) ?? "")

const TOPIC_TRACKS_LIMIT = 60

async function load(topicId: string): Promise<void> {
  tracks.value = []
  try {
    const repos = app.repositories()
    await dictionaries.ensureLoaded()
    const ids = await repos.topics.topTrackIds(topicId, TOPIC_TRACKS_LIMIT)
    if (ids.length === 0) return
    const byId = await repos.tracks.getByIds([...ids])
    tracks.value = ids.map((id) => byId.get(id)).filter((tr): tr is Track => tr !== undefined)
  } catch (err) {
    console.warn("[topic] load failed", err)
    tracks.value = []
  }
}

watch(() => props.topicId, (id) => void load(id), { immediate: true })

async function onSelectTrack(trackId: string): Promise<void> {
  await trackActions.present(trackId as TrackId)
}

async function onAdd(): Promise<void> {
  const count = tracks.value.length
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
  if (tracks.value.length === 0) return
  adding.value = true
  try {
    const result = await addTracksToPlaylist(
      { trackIds: tracks.value.map((tr) => tr.id) },
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
