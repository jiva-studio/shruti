<script lang="ts" setup>
import NotesListItem from "./NotesListItem.vue"
import type { UiNoteRow } from "./types.js"

defineProps<{
  notes: readonly UiNoteRow[]
}>()

const emit = defineEmits<{
  click: [noteId: string]
}>()

// Re-declare the slot scope so consumers get typed `note` access.
defineSlots<{
  player(props: { note: UiNoteRow }): unknown
}>()
</script>

<template>
  <NotesListItem
    v-for="note in notes"
    :key="note.id"
    :note-id="note.id"
    :text="note.text"
    :language="note.language"
    :author-name="note.authorName"
    :track-title="note.trackTitle"
    :track-date="note.trackDate"
    :reference="note.reference"
    @click="emit('click', note.id)"
  >
    <template #player>
      <slot name="player" :note="note" />
    </template>
  </NotesListItem>
</template>
