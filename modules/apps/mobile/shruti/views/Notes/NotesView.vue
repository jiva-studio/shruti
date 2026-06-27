<template>
  <IonPage>
    <FlatHeader v-if="!isEmpty">
      <IonToolbar>
        <SearchInput
          :model-value="query"
          :placeholder="$t('app.search')"
          @update:model-value="onQuery"
        />
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <!-- Notes -->
      <NotesList v-if="!isEmpty" :notes="rows" @click="onNoteClicked">
        <template #player="{ note }">
          <NotesInlinePlayer
            v-if="showPlayerOnNotes"
            :note="{
              noteId: note.id,
              trackId: note.trackId,
              sourceKey: note.audioPath ?? '',
              timeStart: note.timeStart,
              timeEnd: note.timeEnd,
            }"
            :cut="(a) => shareAudioService.cut(a)"
            :predict-url="(id) => buildServerUrl(activeServer, 'public/shares/audio/' + id + '.mp3')"
            @click.stop
          >
            <template #spinner><IonSpinner name="crescent" class="play-btn-spinner" /></template>
          </NotesInlinePlayer>
        </template>
      </NotesList>

      <!-- No notes -->
      <PageSticker
        v-if="isEmpty"
        :header="$t('notes.notesAreEmpty')"
        :message="$t('notes.addMoreNotes')"
        :image="emptyImage"
        to="search"
      />

      <div v-if="player.open" class="bottom-reserve" />
    </IonContent>

    <!-- Action Sheet for note actions -->
    <IonActionSheet
      :is-open="isActionSheetOpen"
      :buttons="actionSheetButtons"
      :header="$t('notes.noteAction')"
      @did-dismiss="isActionSheetOpen = false"
    />
  </IonPage>
</template>

<script setup lang="ts">
import { IonActionSheet, IonContent, IonPage, IonSpinner, IonToolbar } from "@ionic/vue"
import { FlatHeader, PageSticker } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { NotesList } from "@ui/features/notes/index.js"
import { useShruti } from "@shruti/shruti.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useNotesController } from "./NotesView.controller.js"
import NotesInlinePlayer from "./NotesInlinePlayer.vue"

const { shareAudioService, activeServer } = useShruti()
const player = usePlayerStore()
const { rows, isEmpty, query, isActionSheetOpen, actionSheetButtons, onQuery, onNoteClicked } =
  useNotesController()
const showPlayerOnNotes = useConfig<boolean>("settings.showPlayerOnNotes", true)

const emptyImage = "/notes-empty.png"
</script>

<style scoped>
.bottom-reserve {
  width: 100%;
  height: var(--kit-page-reserved-space, 0px);
}
</style>
