<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :text="note.text"
    :tags="note.tags"
    :author="note.trackAuthor"
    :source="note.trackTitle"
    @click="onClick(note)"
  />
</template>


<script lang="ts" setup>
import { Share } from '@capacitor/share'
import { Note } from '../models'
import NotesListItem from './NotesListItem.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  notes: Note[]
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onClick(note: Note) {
  await Share.share({ text: note.text })
}
</script>

