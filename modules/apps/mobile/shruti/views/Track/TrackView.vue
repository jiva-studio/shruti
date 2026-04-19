<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/home" />
        </IonButtons>
        <IonTitle>Track</IonTitle>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true" class="ion-padding">
      <IonText v-if="track.error.value" color="danger">
        <p>{{ track.error.value }}</p>
      </IonText>

      <template v-else-if="track.track.value">
        <IonText>
          <h2>{{ track.title.value }}</h2>
          <p>{{ track.authorName.value }}</p>
        </IonText>

        <IonList v-if="track.availableLanguages.value.length">
          <IonItem>
            <IonLabel>Language</IonLabel>
            <IonSelect
              :value="track.selectedLanguage.value"
              interface="popover"
              @ion-change="onLanguageChange"
            >
              <IonSelectOption v-for="l in track.availableLanguages.value" :key="l" :value="l">
                {{ l }}
              </IonSelectOption>
            </IonSelect>
          </IonItem>
        </IonList>

        <TranscriptView
          v-if="track.transcriptBlocks.value.length"
          :blocks="track.transcriptBlocks.value"
          @seek="track.onSeek"
        />
        <IonText v-else-if="!track.isLoadingTranscript.value" color="medium">
          <p>No transcript available for this track.</p>
        </IonText>
        <IonText v-else color="medium">
          <p>Loading transcript…</p>
        </IonText>
      </template>

      <IonText v-else color="medium">
        <p>Loading track…</p>
      </IonText>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSelect,
  IonSelectOption,
  IonText,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { useTrackController } from "./TrackView.controller.js"
import { TranscriptView } from "@ui/features/transcript/index.js"

interface Props {
  trackId: string
}
const props = defineProps<Props>()

const track = useTrackController({ trackId: props.trackId })

function onLanguageChange(event: CustomEvent<{ value: string }>): void {
  track.onLanguageChange(event.detail.value)
}
</script>
