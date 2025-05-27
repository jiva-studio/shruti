<template>
  <Page>
    <PlaylistSection
      @click="playlistItemId => playTrackOperation().execute(playlistItemId)"
      @delete="playlistItemId => archivePlaylistItem().execute(playlistItemId)"
    />
  </Page>
</template>


<script setup lang="ts">
import { Page } from '@shruti/mobile/features/app.core'
import { PlaylistSection } from '@shruti/mobile/features/playlist'
import { playTrackOperation, archivePlaylistItem } from '@shruti/mobile/operations'
</script>