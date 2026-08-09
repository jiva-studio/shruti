<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/home" />
        </IonButtons>
        <IonTitle>{{ $t("track.title") }}</IonTitle>
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

        <IonButton
          v-if="track.hasAudio.value"
          expand="block"
          class="ion-margin-vertical"
          @click="track.onPlay"
        >
          <IconPlayerPlayFilled slot="start" :size="20" style="margin-inline-end: 8px" />
          {{ $t("track.play") }}
        </IonButton>

        <TrackLanguageSelector
          :label="$t('track.language')"
          :languages="track.availableLanguages.value"
          :value="track.selectedLanguage.value"
          @update:value="track.onLanguageChange"
        />
      </template>

      <IonText v-else color="medium">
        <p>{{ $t("track.loading") }}</p>
      </IonText>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconPlayerPlayFilled } from "@tabler/icons-vue"
import { TrackLanguageSelector } from "@ui/features/tracks/index.js"
import { useTrackController } from "./TrackView.controller.js"

interface Props {
  /** Track ID, sourced from the route's `:trackId` param. */
  trackId: string
}
const props = defineProps<Props>()

const track = useTrackController({ trackId: props.trackId })
</script>
