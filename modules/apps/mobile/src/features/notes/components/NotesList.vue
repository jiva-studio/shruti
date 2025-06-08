<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :text="note.text"
    :tags="note.tags"
    :author="note.trackAuthor"
    :source="note.trackTitle"
  />
</template>


<script lang="ts" setup>
import { Note } from '../models'
import NotesListItem from './NotesListItem.vue'

defineProps<{
  notes: Note[]
}>()
</script>

