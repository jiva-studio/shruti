<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonTitle>Search</IonTitle>
      </IonToolbar>
      <IonToolbar>
        <SearchInput v-model="search.query.value" />
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true">
      <IonText v-if="search.error.value" color="danger" class="ion-padding">
        <p>{{ search.error.value }}</p>
      </IonText>
      <TracksList
        :rows="search.rows.value"
        :empty-message="search.emptyMessage.value"
        @select="search.onSelect"
      />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonContent, IonHeader, IonPage, IonText, IonTitle, IonToolbar } from "@ionic/vue"
import { SearchInput } from "@ui/features/tracks.search.input/index.js"
import { TracksList } from "@ui/features/tracks.list/index.js"
import { useSearchController } from "./SearchView.controller.js"

const search = useSearchController()
</script>
