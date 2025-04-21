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
      <TracksListItem
        v-for="item in tracks"
        :key="item.trackId"
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
    </template>

    <PlaylistIsEmpty
      v-else-if="!isFirstLoad && tracks.length === 0"
      @click="goToLibrary"
    />
  </IonList>
</template>


<script setup lang="ts">
import { useAsyncState } from '@vueuse/core'
import { IonList } from '@ionic/vue'
import { SectionHeader, PlaylistIsEmpty, useHomeScenarios, useUserSelectsTrackToPlay } from '@/home'
import { TracksListItem, TracksListItemSkeleton, useConfig } from '@/app'
import { computed } from 'vue'
import { useRouter } from 'vue-router'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const homeScenarios = useHomeScenarios()
const config = useConfig()
const router = useRouter()
const userSelectsTrackToPlay = useUserSelectsTrackToPlay()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { state: tracks, execute: refresh, isLoading } = useAsyncState(
  async () => await homeScenarios.userSeesUpNextTracksScenario.execute(config.appLanguage.value), 
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

function goToLibrary() {
  router.replace({ name: 'library' })
}
</script>