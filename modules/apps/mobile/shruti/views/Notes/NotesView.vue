<template>
  <AppPage :reserve-player-space="player.open">
    <!-- Search Query -->
    <SearchInput
      v-if="!isEmpty"
      :model-value="query"
      :placeholder="$t('app.search')"
      @update:model-value="onQuery"
    />

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
          @click.stop
        />
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

    <!-- Action Sheet for note actions -->
    <IonActionSheet
      :is-open="isActionSheetOpen"
      :buttons="actionSheetButtons"
      :header="$t('notes.noteAction')"
      @did-dismiss="isActionSheetOpen = false"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { IonActionSheet } from "@ionic/vue"
import { AppPage, PageSticker } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { NotesList } from "@ui/features/notes/index.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useNotesController } from "./NotesView.controller.js"
import NotesInlinePlayer from "./NotesInlinePlayer.vue"

const player = usePlayerStore()
const { rows, isEmpty, query, isActionSheetOpen, actionSheetButtons, onQuery, onNoteClicked } =
  useNotesController()
const showPlayerOnNotes = useConfig<boolean>("settings.showPlayerOnNotes", true)

const emptyImage = "/notes-empty.png"
</script>
