<template>
  <SectionHeader :title="$t('home.upNext')" />
  <IonList
    lines="none"
  >
    <template v-if="isFirstLoad">
      <TracksListItemSkeleton
        v-for="i in 3"
        :key="i"
      />
    </template>

    <template v-else-if="!isFirstLoad && tracks.length > 0">
      <IonItemSliding
        v-for="item in tracks"
        :key="item.trackId"
      >
        <TracksListItem
          :track-id="item.trackId"
          :title="item.title"
          :author="item.author"
          :location="item.location"
          :references="item.references"
          :tags="item.tags"
          :date="item.date"
          :icon="trackStateStore.isCompleted(item.trackId) ? 'completed' : trackStateStore.downloadFailed(item.trackId) ? 'failed' : 'none'"
          :progress="trackStateStore.downloadProgress(item.trackId)"
          :dimmed="trackStateStore.isDownloading(item.trackId) || trackStateStore.downloadFailed(item.trackId)"
          @click="() => onPlaylistItemClicked(item.trackId, trackStateStore.getStatus(item.trackId).downloadFailed === true)"
        />
        <IonItemOptions>
          <IonItemOption
            color="danger"
            @click="() => onRemovePlaylistItem(item.trackId)"
          >
            <IonIcon
              slot="icon-only"
              :icon="trashOutline"
            />
          </IonItemOption>
        </IonItemOptions>
      </IonItemSliding>
    </template>

    <PlaylistIsEmpty
      v-else-if="!isFirstLoad && tracks.length === 0"
      @click="goToLibrary"
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList, IonItemSliding, IonItemOptions, IonItemOption, IonIcon } from '@ionic/vue'
import { 
  SectionHeader, PlaylistIsEmpty, useUserSelectsTrackToPlayScenario, 
  useUserSeesUpNextTracksScenario, useUserRemovesPlaylistItemScenario,
  useUserRedownloadsFailedMediaItemsScenario
} from '@lectorium/mobile/home'
import { TracksListItem, TracksListItemSkeleton, useConfig } from '@lectorium/mobile/app'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { trashOutline } from 'ionicons/icons'
import { useTrackStateStore } from '@lectorium/mobile/app/stores'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const router = useRouter()
const trackStateStore = useTrackStateStore()
const userSeesUpNextTracks = useUserSeesUpNextTracksScenario()
const userSelectsTrackToPlay = useUserSelectsTrackToPlayScenario()
const userRemovesPlaylistItem = useUserRemovesPlaylistItemScenario()
const userRedownloadsFailedMediaItems = useUserRedownloadsFailedMediaItemsScenario()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state: tracks, execute: refresh } = useAsyncState(
  async () => await userSeesUpNextTracks.execute(config.appLanguage.value), 
  [], { 
    immediate: true, 
    resetOnExecute: false, 
    onSuccess: () => isFirstLoad.value = false,
  }
)

const isFirstLoad = ref(true)

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineExpose({ refresh })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onRemovePlaylistItem(playlistItemId: string) {
  await userRemovesPlaylistItem.execute(playlistItemId)
}

function onPlaylistItemClicked(trackId: string, redownload: boolean) {
  if (!redownload) {
    userSelectsTrackToPlay.execute(trackId)
  } else {
    userRedownloadsFailedMediaItems.execute(trackId)
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function goToLibrary() {
  router.replace({ name: 'library' })
}
</script>