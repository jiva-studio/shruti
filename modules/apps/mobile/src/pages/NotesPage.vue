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
      @click="onNoteClicked"
    />

    <!-- No notes -->
    <PageSticker
      v-if="notesStore.isEmpty"
      :header="$t('notes.notesAreEmpty')"
      :message="$t('notes.addMoreNotes')"
      :image="notesAreEmptyImg"
      navigation-path="search"
    />

    <!-- Action Sheet for note actions -->
    <IonActionSheet
      :is-open="isActionSheetOpen"
      :buttons="actionSheetButtons"
      :header="$t('notes.noteAction')"
      @did-dismiss="isActionSheetOpen = false"
    />
  </Page>
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { Share } from '@capacitor/share'
import { IonActionSheet } from '@ionic/vue'
import { useEventBus } from '@lectorium/mobile/core'
import { Page, SearchInput } from '@blocks/app.core'
import { NotesList, useNotesStore } from '@blocks/app.notes'
import { PageSticker } from '@blocks/app.ui.kit'
import { useDAL } from '@blocks/app.database'
import notesAreEmptyImg from '../assets/empty.png'
import { useLocalization } from '@blocks/app.localization'
import { Haptics, ImpactStyle } from '@capacitor/haptics'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const i18n = useLocalization()
const eventBus = useEventBus()
const notesStore = useNotesStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const selectedNoteId = ref<string | null>(null)
const isActionSheetOpen = ref(false)
const actionSheetButtons = [
  {
    text: i18n.global.t('app.share'),
    handler: () => {
      onShareNoteClicked(selectedNoteId.value!)
    },
  },
  {
    text: i18n.global.t('app.delete'),
    role: 'destructive',
    handler: () => {
      if (!selectedNoteId.value) return
      eventBus.notesDelete.notify({ noteId: selectedNoteId.value })
    },
  },
  {
    text: i18n.global.t('app.cancel'),
    role: 'cancel',
  },
]

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onShareNoteClicked(noteId: string) {
  Haptics.impact({ style: ImpactStyle.Light })
  const note = await dal.notes.getOne(noteId)
  const textWithoutTags = note.text.replace(/<[^>]*>/g, '')
  await Share.share({ text: textWithoutTags })
}

async function onNoteClicked(noteId: string) {
  Haptics.impact({ style: ImpactStyle.Light })
  selectedNoteId.value = noteId
  isActionSheetOpen.value = true
}
</script>