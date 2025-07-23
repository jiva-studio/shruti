<template>
  <WithLongPress 
    v-for="note in notes"
    :key="note.id"
    :delay="500"
    @long-press="emit('share', note.id)"
  >
    <NotesListItem
      :text="note.text"
      :language="note.language"
      :tags="note.tags"
      :author="note.trackAuthor"
      :source="note.trackTitle"
      @click="emit('click', note.id)"
    />
  </WithLongPress>
</template>


<script lang="ts" setup>
import WithLongPress from '@blocks/app.core/components/WithLongPress.vue'
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

