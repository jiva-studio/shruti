<template>
  <Page>
    <PlaylistSection
      @click="playlistItemId => playTrackOperation().execute(playlistItemId)"
      @delete="playlistItemId => archivePlaylistItem().execute(playlistItemId)"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@lectorium/mobile/features/app.core'
import { PlaylistSection } from '@lectorium/mobile/features/playlist'
import { playTrackOperation, archivePlaylistItem } from '@lectorium/mobile/operations'
</script>