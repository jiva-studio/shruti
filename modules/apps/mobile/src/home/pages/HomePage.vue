<template>
  <Page>
    <UpNextTracksSection ref="upNextTracksRef" />
    <TrackSuggestionsSection />
  </Page>
</template>

<script setup lang="ts">
import { TrackSuggestionsSection, UpNextTracksSection } from '@/home'
import { Page, useDAL } from '@/app'
import { ref } from 'vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const upNextTracksRef = ref<typeof UpNextTracksSection>() 

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
</script>
