<template>
  <Page :loading="loading">
    <RandomTrackSuggestions 
      :max-authors="2"
      @loading="onLoadingStateChanged"
    />
  </Page>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { Page, useConfig } from '@lectorium/mobile/app'
import RandomTrackSuggestions from '@lectorium/mobile/library/containers/RandomTrackSuggestions.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const trackSuggestionsRef = ref<typeof RandomTrackSuggestions>()
const loading = ref(true)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onLoadingStateChanged(value: boolean) {
  loading.value = value
}

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(config.appLanguage, () => {
  trackSuggestionsRef.value?.refresh()
})
</script>