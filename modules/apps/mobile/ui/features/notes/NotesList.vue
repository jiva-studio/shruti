<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :note-id="note.id"
    :text="note.text"
    :language="note.language"
    :tags="note.tags"
    :author="note.author"
    :source="note.source"
    @click="emit('click', note.id)"
  />
</template>

<script lang="ts" setup>
import NotesListItem from "./NotesListItem.vue"
import type { UiNoteRow } from "./types.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  notes: readonly UiNoteRow[]
}>()

const emit = defineEmits<{
  click: [noteId: string]
}>()
</script>
