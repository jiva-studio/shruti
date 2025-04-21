<template>
  <Page>
    <UpNextTracksSection ref="upNextTracksRef" />
    <TrackSuggestionsSection ref="trackSuggestionsRef" />
  </Page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { TrackSuggestionsSection, UpNextTracksSection } from '@/home'
import { Page, useDAL, useConfig } from '@/app'

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

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

// onIonViewDidEnter(() => {
//   upNextTracksRef.value?.refresh()
// })
dal.mediaItems.subscribe(async () => {
  upNextTracksRef.value?.refresh()
})
dal.playlistItems.subscribe(async () => {
  upNextTracksRef.value?.refresh()
})
watch(config.appLanguage, async () => {
  upNextTracksRef.value?.refresh()
  trackSuggestionsRef.value?.refresh()
})
</script>
