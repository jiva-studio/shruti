<template>
  <AppPage :loading="isLoading && rows.length === 0">
    <IonText v-if="error" color="danger" class="ion-padding">
      <p>{{ error }}</p>
    </IonText>
    <PlaylistSection
      v-else
      :rows="rows"
      :up-next-title="$t('home.upNext')"
      :empty-header="$t('home.playlistIsEmpty')"
      :empty-message="$t('home.tapToAddTracks')"
      :empty-image="emptyImage"
      @click="onSelect"
      @delete="onRemove"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { IonText } from "@ionic/vue"
import { AppPage } from "@ui/primitives/index.js"
import { PlaylistSection } from "@ui/features/playlist/index.js"
import { useHomeController } from "./HomeView.controller.js"

const emptyImage = "/playlist-empty.png"

const { rows, isLoading, error, onSelect, onRemove } = useHomeController()
</script>
