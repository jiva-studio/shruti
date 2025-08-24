<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :text="note.text"
    :language="note.language"
    :tags="note.tags"
    :author="note.trackAuthor"
    :source="note.trackTitle"
    @click="emit('click', note.id)"
  />
</template>


<script lang="ts" setup>
import { Note } from '../models'
import NotesListItem from './NotesListItem.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  notes: Note[]
}>()

const emit = defineEmits<{
  share: [noteId: string]
  click: [noteId: string]
}>()
</script>

