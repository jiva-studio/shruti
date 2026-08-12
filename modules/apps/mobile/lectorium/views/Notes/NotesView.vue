<template>
  <IonPage>
    <FlatHeader v-if="!isEmpty && !hasError">
      <IonToolbar>
        <SearchInput
          class="page-search"
          :model-value="query"
          :placeholder="$t('app.search')"
          @update:model-value="onQuery"
        />
      </IonToolbar>
    </FlatHeader>

    <IonContent :fullscreen="true">
      <!-- Notes -->
      <NotesList v-if="!sticker" :notes="rows" @click="onNoteClicked">
        <template #player="{ note }">
          <NotesInlinePlayer
            v-if="showPlayerOnNotes"
            :note="{
              noteId: note.id,
              trackId: note.trackId,
              sourceKey: note.audioPath ?? '',
              timeStart: note.timeStart,
              timeEnd: note.timeEnd,
            }"
            :cut="(a) => shareAudioService.cut(a)"
            :predict-url="
              (id) => buildServerUrl(activeServer, 'public/shares/audio/' + id + '.mp3')
            "
            @click.stop
          >
            <template #spinner><IonSpinner name="crescent" class="play-btn-spinner" /></template>
          </NotesInlinePlayer>
        </template>
      </NotesList>

      <!-- The three ways this page has no list to draw: nothing written yet,
           a search nothing matched, and a read that failed. They are not the
           same news, and the onboarding copy is only true for the first. -->
      <PageSticker
        v-if="sticker"
        :header="sticker.header"
        :message="sticker.message"
        :image="sticker.image"
        :to="sticker.to"
      />

      <DockSpacer />
    </IonContent>

    <!-- Action Sheet for note actions -->
    <IonActionSheet
      :is-open="isActionSheetOpen"
      :buttons="actionSheetButtons"
      :header="$t('notes.noteAction')"
      @did-dismiss="isActionSheetOpen = false"
    />
  </IonPage>
</template>

<script setup lang="ts">
import { IonActionSheet, IonContent, IonPage, IonSpinner, IonToolbar } from "@ionic/vue"
import { FlatHeader, PageSticker } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { NotesList } from "@ui/features/notes/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useNotesController } from "./NotesView.controller.js"
import NotesInlinePlayer from "./NotesInlinePlayer.vue"
import DockSpacer from "@lectorium/components/DockSpacer.vue"

const { shareAudioService, activeServer } = useLectorium()
const {
  rows,
  isEmpty,
  hasError,
  sticker,
  query,
  isActionSheetOpen,
  actionSheetButtons,
  onQuery,
  onNoteClicked,
} = useNotesController()
const showPlayerOnNotes = useConfig<boolean>("settings.showPlayerOnNotes", true)
</script>

<style scoped>
/* Align the search field with the note cards (margin: 1rem 16px). Zero the
   toolbar's own inline padding (md 0 / ios 4px) and let the field carry the
   full 16px gutter, so the field's left edge matches the cards on every
   platform. See SearchInput.vue's .search comment. */
ion-toolbar {
  --padding-start: 0;
  --padding-end: 0;
}
.page-search {
  --search-gutter: 16px;
}
</style>
