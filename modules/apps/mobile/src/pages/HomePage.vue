<template>
  <Page>
    <OnboardingMessages />
    <PlaylistSection
      @click="onPlaylistItemClicked"
      @delete="onArchivePlaylistItem"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@blocks/app.core'
import { PlaylistSection  } from '@blocks/app.playlist'
import { useEventBus } from '@shruti/mobile/core'
import OnboardingMessages from './home/OnboardingMessages.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const eventBus = useEventBus()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onPlaylistItemClicked(playlistItemId: string) {
  eventBus.trackPlay.notify({ playlistItemId })
}

function onArchivePlaylistItem(playlistItemId: string) {
  eventBus.playlistArchiveItem.notify({ playlistItemId })
}
</script>
