<script setup lang="ts">
import { computed } from "vue"
import { IonSpinner } from "@ionic/vue"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useLectorium } from "@lectorium/lectorium.js"
import NotesInlinePlayer from "./NotesInlinePlayer.vue"

const props = defineProps<{ note: UiNoteRow }>()

const { shareAudioService, activeServer } = useLectorium()

const audioRef = computed(() => ({
  noteId: props.note.id,
  trackId: props.note.trackId,
  sourceKey: props.note.audioPath ?? "",
  timeStart: props.note.timeStart,
  timeEnd: props.note.timeEnd,
}))

const cut = shareAudioService.cut.bind(shareAudioService)

function predictUrl(id: string): string {
  return buildServerUrl(activeServer.value, `public/shares/audio/${id}.mp3`)
}
</script>

<template>
  <NotesInlinePlayer :note="audioRef" :cut="cut" :predict-url="predictUrl" @click.stop>
    <template #spinner><IonSpinner name="crescent" class="play-btn-spinner" /></template>
  </NotesInlinePlayer>
</template>
