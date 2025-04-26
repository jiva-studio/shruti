<template>
  <Page>
    <UpNextTracksSection ref="upNextTracksRef" />
    <TrackSuggestionsSection ref="trackSuggestionsRef" />
  </Page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useTimeoutPoll } from '@vueuse/core'
import { TrackSuggestionsSection, UpNextTracksSection } from '@/home'
import { Page, useDAL, useConfig, TracksListItemData } from '@/app'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const config = useConfig()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const upNextTracksRef = ref<typeof UpNextTracksSection>() 
const trackSuggestionsRef = ref<typeof TrackSuggestionsSection>()
const refreshUpNext = useTimeoutPoll(refresh, 1500, { immediate: false }) 


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

dal.mediaItems.subscribe(refresh)
dal.playlistItems.subscribe(refresh)
watch(config.appLanguage, () => {
  refresh()
  trackSuggestionsRef.value?.refresh()
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function refresh() {
  const items = (await upNextTracksRef.value?.refresh()) as TracksListItemData[]
  if (!items) { return }
  const isLoading = items.filter(x => x.status === 'loading').length > 0
  if (isLoading) { refreshUpNext.resume() } else { refreshUpNext.pause() }
}
</script>