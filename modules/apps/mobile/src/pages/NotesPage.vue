<template>
  <Page>
    <!-- Search input text -->
    <SearchInput
      v-model="notesStore.searchQuery"
      :placeholder="$t('app.search')"
    />

    <!-- Notes -->
    <NotesList :notes="notesStore.searchQuery ? notesStore.searchResults : notesStore.items" />
  </Page>
</template>


<script setup lang="ts">
import { Page, SearchInput } from '@lectorium/mobile/features/app.core'
import { NotesList, useNotesStore } from '../features/notes'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const notesStore = useNotesStore()
</script>