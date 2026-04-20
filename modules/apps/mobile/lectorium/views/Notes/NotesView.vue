<template>
  <AppPage :player-open="player.open">
    <!-- Search Query -->
    <SearchInput
      v-if="!isEmpty"
      :model-value="query"
      :placeholder="$t('app.search')"
      @update:model-value="onQuery"
    />

    <!-- Notes -->
    <NotesList
      v-if="!isEmpty"
      :notes="rows"
      @click="onNoteClicked"
    />

    <!-- No notes -->
    <PageSticker
      v-if="isEmpty"
      :header="$t('notes.notesAreEmpty')"
      :message="$t('notes.addMoreNotes')"
      :image="emptyImage"
      navigation-path="search"
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
import { SearchInput } from "@ui/components/tracks.search.input/index.js"
import { NotesList } from "@ui/features/notes/index.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { useNotesController } from "./NotesView.controller.js"

const player = usePlayerStore()
const { rows, isEmpty, query, isActionSheetOpen, actionSheetButtons, onQuery, onNoteClicked } =
  useNotesController()

const emptyImage = "/empty.png"
</script>
