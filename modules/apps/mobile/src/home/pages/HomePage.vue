<template>
  <Page>
    <UpNextTracksSection ref="upNextTracksRef" />
    <TrackSuggestionsSection ref="trackSuggestionsRef" />
  </Page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { TrackSuggestionsSection, UpNextTracksSection } from '@lectorium/mobile/home'
import { Page, useDAL, useConfig } from '@lectorium/mobile/app'

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

dal.playlistItems.subscribe(refresh)
watch(config.appLanguage, () => {
  refresh()
  trackSuggestionsRef.value?.refresh()
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function refresh() {
  await upNextTracksRef.value?.refresh()
}
</script>