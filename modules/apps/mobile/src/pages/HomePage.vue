<template>
  <Page>
    <!-- Sign In Settings Item -->
    <Transition>
      <Message 
        v-if="!config.userEmail.value && playlist.items.length > 0 && !config.tutorialStepsCompleted.value.includes('signInInvitation')"
        @click="eventBus.authSelectProvider.notify()"
        @close="eventBus.tutorialCompleteStep.notify({ step: 'signInInvitation' })"
      >
        {{ $t('home.signInInvitation') }}
      </Message>
    </Transition>

    <!-- Playlist Section -->
    <PlaylistSection
      @click="onPlaylistItemClicked"
      @delete="onArchivePlaylistItem"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@blocks/app.core'
import { PlaylistSection, usePlaylistStore } from '@blocks/app.playlist'
import { useEventBus } from '@lectorium/mobile/core'
import { useDAL } from '@blocks/app.database'
import { Message } from '@blocks/app.ui.kit'
import { useConfig } from '@blocks/app.config'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()
const eventBus = useEventBus()
const playlist = usePlaylistStore()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onPlaylistItemClicked(playlistItemId: string) {
  eventBus.trackPlay.notify({ playlistItemId })
}

function onArchivePlaylistItem(playlistItemId: string) {
  const dal = useDAL()
  dal.archiveService.archiveOne(playlistItemId)
}
</script>


<style scoped>
.v-enter-active,
.v-leave-active {
  transition: opacity 0.5s ease;
}

.v-enter-from,
.v-leave-to {
  opacity: 0;
}
</style>