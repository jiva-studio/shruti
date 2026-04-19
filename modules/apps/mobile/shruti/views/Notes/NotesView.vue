<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/home" />
        </IonButtons>
        <IonTitle>Notes</IonTitle>
      </IonToolbar>
    </IonHeader>
    <IonContent :fullscreen="true">
      <IonList>
        <IonItem v-if="notes.length === 0" lines="none">
          <IonLabel color="medium">No notes yet.</IonLabel>
        </IonItem>
        <IonItem v-for="note in notes" :key="note.id">
          <IonLabel>
            <h3>{{ note.text }}</h3>
            <p>
              {{ formatTime(note.timeStart) }} – {{ formatTime(note.timeEnd) }} ·
              {{ note.trackId }}
            </p>
          </IonLabel>
        </IonItem>
      </IonList>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue"
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
import type { Note } from "@lib/domain/note.js"
import { useShruti } from "@shruti/shruti.js"

const app = useShruti()
const repos = app.repositories()

const notes = ref<readonly Note[]>([])

onMounted(async () => {
  notes.value = await repos.notes.listRecent(100)
})

function formatTime(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}
</script>
