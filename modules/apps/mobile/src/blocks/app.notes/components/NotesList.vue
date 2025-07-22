<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :text="note.text"
    :tags="note.tags"
    :author="note.trackAuthor"
    :source="note.trackTitle"
    @click="emit('share', note.id)"
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
}>()
</script>

