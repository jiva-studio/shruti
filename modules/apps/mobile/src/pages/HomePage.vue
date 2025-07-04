<template>
  <Page>
    <PlaylistSection
      @click="playlistItemId => Events.playTrackRequested.notify({ playlistItemId })"
      @delete="playlistItemId => archivePlaylistItem().execute(playlistItemId)"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@lectorium/mobile/features/app.core'
import { PlaylistSection } from '@lectorium/mobile/features/playlist'
import { archivePlaylistItem } from '@lectorium/mobile/operations'
import { Events } from '@lectorium/mobile/events'
</script>