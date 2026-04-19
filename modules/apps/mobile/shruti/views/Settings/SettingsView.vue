<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/home" />
        </IonButtons>
        <IonTitle>Settings</IonTitle>
      </IonToolbar>
    </IonHeader>
    <IonContent :fullscreen="true">
      <IonList>
        <IonItem>
          <IonLabel>
            <h3>Version</h3>
            <p>{{ version }} · build {{ buildId }}</p>
          </IonLabel>
        </IonItem>
        <IonItem>
          <IonLabel>
            <h3>Content database</h3>
            <p>Scheme {{ dbScheme }}</p>
          </IonLabel>
        </IonItem>
        <IonItem>
          <IonLabel>
            <h3>Active CDN</h3>
            <p>{{ activeServer.name }} ({{ activeServer.id }})</p>
          </IonLabel>
        </IonItem>
        <IonItem button @click="onClearCache">
          <IonLabel color="danger">Clear downloaded files cache</IonLabel>
        </IonItem>
      </IonList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"

declare const __APP_VERSION__: string
declare const __BUILD_ID__: string
declare const __DB_SCHEME__: number

const app = useShruti()
const version = __APP_VERSION__
const buildId = __BUILD_ID__
const dbScheme = __DB_SCHEME__
const activeServer = computed(() => app.activeServer.value)

async function onClearCache(): Promise<void> {
  await app.filesStorage.clearAll()
}
</script>
