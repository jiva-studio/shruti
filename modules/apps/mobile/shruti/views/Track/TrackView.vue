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
      <IonText v-if="error" color="danger">
        <p>{{ error }}</p>
      </IonText>

      <template v-else-if="track">
        <IonText>
          <h2>{{ title }}</h2>
          <p>{{ authorName }}</p>
        </IonText>

        <IonList v-if="availableLanguages.length">
          <IonItem>
            <IonLabel>Language</IonLabel>
            <IonSelect
              :value="selectedLanguage"
              interface="popover"
              @ion-change="onLanguageChange"
            >
              <IonSelectOption v-for="l in availableLanguages" :key="l" :value="l">
                {{ l }}
              </IonSelectOption>
            </IonSelect>
          </IonItem>
        </IonList>

        <TranscriptView
          v-if="transcriptBlocks.length"
          :blocks="transcriptBlocks"
          @seek="onSeek"
        />
        <IonText v-else-if="!isLoadingTranscript" color="medium">
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
import { computed, onMounted, ref, watch } from "vue"
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
import { loadTranscript } from "@lib/application/loadTranscript.js"
import type { Author } from "@lib/domain/author.js"
import type { Track } from "@lib/domain/track.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { useShruti } from "@shruti/shruti.js"
import { TranscriptView } from "@ui/features/transcript/index.js"
import type { UiTranscriptBlock } from "@ui/features/transcript/index.js"

interface Props {
  trackId: string
}
const props = defineProps<Props>()

const app = useShruti()
const repos = app.repositories()

const track = ref<Track | null>(null)
const author = ref<Author | null>(null)
const availableLanguages = ref<readonly string[]>([])
const selectedLanguage = ref<string | null>(null)
const transcript = ref<Transcript | null>(null)
const isLoadingTranscript = ref<boolean>(false)
const error = ref<string | null>(null)
const preferredLanguage = "en"

const title = computed(() => {
  if (!track.value) return ""
  const variant =
    track.value.variants.find((v) => v.language === (selectedLanguage.value ?? preferredLanguage)) ??
    track.value.variants[0]
  return variant?.title ?? track.value.id
})

const authorName = computed(() => {
  if (!author.value) return track.value?.authorId ?? ""
  return (
    author.value.names.get(selectedLanguage.value ?? preferredLanguage) ??
    author.value.names.values().next().value ??
    author.value.id
  )
})

const transcriptBlocks = computed<readonly UiTranscriptBlock[]>(() => {
  if (!transcript.value) return []
  return transcript.value.blocks.map((b) => {
    // `verse:text` block is the only one whose `reference` field carries domain data
    // not mirrored in the UI type — strip it here.
    if (b.type === "sentence") {
      return { type: "sentence", start: b.start, end: b.end, text: b.text, speaker: b.speaker }
    }
    if (b.type === "verse:text") {
      return { type: "verse:text", start: b.start, end: b.end, text: b.text }
    }
    return b
  })
})

async function loadEverything(): Promise<void> {
  error.value = null
  track.value = await repos.tracks.getById(props.trackId)
  if (!track.value) {
    error.value = "Track not found."
    return
  }
  author.value = await repos.authors.getById(track.value.authorId)
  availableLanguages.value = await repos.transcripts.availableLanguages(props.trackId)
  selectedLanguage.value =
    availableLanguages.value.find((l) => l === preferredLanguage) ??
    availableLanguages.value[0] ??
    null
  await loadTranscriptForSelected()
}

// Monotonic token — each call bumps it; stale responses (from a
// previous language selection) check if their token is still current
// before writing to `transcript` / `error`. Prevents out-of-order
// overwrites when the user switches language quickly.
let transcriptToken = 0

async function loadTranscriptForSelected(): Promise<void> {
  if (!selectedLanguage.value) {
    transcript.value = null
    return
  }
  const token = ++transcriptToken
  isLoadingTranscript.value = true
  try {
    const result = await loadTranscript(
      { trackId: props.trackId, preferredLanguage: selectedLanguage.value },
      { transcripts: repos.transcripts }
    )
    if (token !== transcriptToken) return
    transcript.value = result.ok ? result.value.transcript : null
    if (!result.ok && result.error !== "no-transcript-available") {
      error.value = `Transcript failed to load: ${result.error}`
    }
  } finally {
    if (token === transcriptToken) isLoadingTranscript.value = false
  }
}

function onLanguageChange(event: CustomEvent<{ value: string }>): void {
  selectedLanguage.value = event.detail.value
}

function onSeek(position: number): void {
  // Player wiring lands in a follow-up phase; log for now so the interaction
  // is observable in dev builds.
  console.info(`seek requested to ${position}`)
}

watch(selectedLanguage, () => {
  void loadTranscriptForSelected()
})

onMounted(() => {
  void loadEverything()
})
</script>
