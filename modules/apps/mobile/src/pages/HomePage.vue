<template>
  <Page>
    <PlaylistSection
      @click="playlistItemId => Events.playTrackRequested.notify({ playlistItemId })"
      @delete="playlistItemId => archivePlaylistItem().execute(playlistItemId)"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@shruti/mobile/features/app.core'
import { PlaylistSection } from '@shruti/mobile/features/playlist'
import { archivePlaylistItem } from '@shruti/mobile/operations'
import { Events } from '@shruti/mobile/events'
</script>