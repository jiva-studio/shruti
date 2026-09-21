<script setup lang="ts">
import {
  IonActionSheet,
  IonContent,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonPage,
  IonToolbar,
  onIonViewWillLeave,
  type InfiniteScrollCustomEvent,
} from "@ionic/vue"
import { pauseGroup } from "@lib/chat/audio/useAudioOrchestrator.js"
import { FlatHeader, PageSticker } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks/search/input/index.js"
import { NotesList } from "@ui/features/notes/index.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useNotesController } from "./NotesView.controller.js"
import NoteRowPlayer from "./NoteRowPlayer.vue"
import DockSpacer from "@lectorium/components/DockSpacer.vue"

const {
  rows,
  isEmpty,
  hasError,
  sticker,
  query,
  hasMore,
  searchTruncated,
  searchLimit,
  isActionSheetOpen,
  actionSheetButtons,
  onQuery,
  loadMore,
  onNoteClicked,
} = useNotesController()
const showPlayerOnNotes = useConfig<boolean>("settings.showPlayerOnNotes", true)

async function onInfinite(e: InfiniteScrollCustomEvent): Promise<void> {
  loadMore()
  await e.target.complete()
}

// Ionic keeps this tab mounted, so no per-row unmount fires when the user
// navigates away and an excerpt would keep playing over the next screen.
// "inline" only — the lecture in the floating player keeps going. Same hook
// ChatView uses for its citation snippets.
onIonViewWillLeave(() => {
  pauseGroup("inline")
})
</script>

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
          <!-- No player for a note whose lecture left the catalog: it has no
               source, so its play button would be fully enabled and do
               nothing. The note's own text stays. -->
          <NoteRowPlayer v-if="showPlayerOnNotes && !note.trackUnresolved" :note="note" />
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

      <!-- The corpus is unbounded and every row mounts an <audio> element, so
           the list pages in `PAGE_SIZE` rows at a time instead of rendering
           the lot (same shape as HomeView's playlist). -->
      <IonInfiniteScroll :disabled="!hasMore" @ion-infinite="onInfinite">
        <IonInfiniteScrollContent />
      </IonInfiniteScroll>

      <!-- The search scan stops at its cap on purpose, so paging cannot reach
           what matched past it. Say so: a list that just ends reads as "that
           note isn't there". -->
      <p v-if="searchTruncated && !hasMore" class="search-capped">
        {{ $t("notes.searchTruncated", { count: searchLimit }) }}
      </p>

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
.search-capped {
  margin: 0 16px 1rem;
  color: var(--ion-color-medium);
  font-size: 0.8125rem;
  text-align: center;
}
</style>
