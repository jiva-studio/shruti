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
          :date="item.date"
          :status="item.status"
          :enabled="item.status === 'none'"
          @click="() => {
            userSelectsTrackToPlay.execute(item.trackId)
          }"
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
  useUserSeesUpNextTracksScenario, useUserRemovesPlaylistItemScenario
} from '@/home'
import { TracksListItem, TracksListItemSkeleton, useConfig } from '@/app'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { trashOutline } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const router = useRouter()
const userSeesUpNextTracks = useUserSeesUpNextTracksScenario()
const userSelectsTrackToPlay = useUserSelectsTrackToPlayScenario()
const userRemovesPlaylistItem = useUserRemovesPlaylistItemScenario()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state: tracks, execute: refresh, isLoading } = useAsyncState(
  async () => await userSeesUpNextTracks.execute(config.appLanguage.value), 
  [], { immediate: true, resetOnExecute: false }
)

const isFirstLoad = computed(() => tracks.value.length === 0 && isLoading.value)

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

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function goToLibrary() {
  router.replace({ name: 'library' })
}
</script>