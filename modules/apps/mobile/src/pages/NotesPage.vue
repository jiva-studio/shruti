<template>
  <Page>
    <!-- Search Query -->
    <SearchInput
      v-if="!notesStore.isEmpty"
      v-model="notesStore.searchQuery"
      :placeholder="$t('app.search')"
    />

    <!-- Notes -->
    <NotesList 
      v-if="!notesStore.isEmpty"
      :notes="notesStore.searchQuery ? notesStore.searchResults : notesStore.items"
      @share="onShareNoteClicked"
    />

    <!-- No notes -->
    <PageSticker
      v-if="notesStore.isEmpty"
      :header="$t('notes.notesAreEmpty')"
      :message="$t('notes.addMoreNotes')"
      :image="notesAreEmptyImg"
      navigation-path="search"
    />
  </Page>
</template>


<script setup lang="ts">
import { Share } from '@capacitor/share'
import { Page, SearchInput } from '@blocks/app.core'
import { NotesList, useNotesStore } from '@blocks/app.notes'
import { PageSticker } from '@blocks/app.ui.kit'
import { useDAL } from '@blocks/app.database'
import notesAreEmptyImg from '../assets/empty.png'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const notesStore = useNotesStore()
const dal = useDAL()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onShareNoteClicked(noteId: string) {
  const note = await dal.notes.getOne(noteId)
  await Share.share({ text: note.text })
}
</script>