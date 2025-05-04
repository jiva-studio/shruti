<template>
  <Page>
    <UpNextTracksSection ref="upNextTracksRef" />
  </Page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { UpNextTracksSection } from '@lectorium/mobile/home'
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


/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

dal.playlistItems.subscribe(refresh)
watch(config.appLanguage, () => {
  refresh()
})

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function refresh() {
  await upNextTracksRef.value?.refresh()
}
</script>