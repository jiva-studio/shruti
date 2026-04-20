<template>
  <AppPage :player-open="player.open">
    <!-- Search Query -->
    <SearchInput
      v-if="!isEmpty"
      :model-value="store.query"
      :placeholder="$t('app.search')"
      @update:model-value="onQuery"
    />

    <!-- Notes -->
    <NotesList
      v-if="!isEmpty"
      :notes="rows"
      @click="onNoteClicked"
    />

    <!-- No notes -->
    <PageSticker
      v-if="isEmpty"
      :header="$t('notes.notesAreEmpty')"
      :message="$t('notes.addMoreNotes')"
      :image="emptyImage"
      navigation-path="search"
    />

    <!-- Action Sheet for note actions -->
    <IonActionSheet
      :is-open="isActionSheetOpen"
      :buttons="actionSheetButtons"
      :header="$t('notes.noteAction')"
      @did-dismiss="isActionSheetOpen = false"
    />
  </AppPage>
</template>


<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { IonActionSheet } from "@ionic/vue"
import { Haptics, ImpactStyle } from "@capacitor/haptics"
import { useI18n } from "vue-i18n"
import { AppPage, PageSticker } from "@ui/primitives/index.js"
import { SearchInput } from "@ui/components/tracks.search.input/index.js"
import { NotesList, type UiNoteRow } from "@ui/features/notes/index.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import type { NoteId } from "@lib/domain/core.js"

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { t } = useI18n()
const store = useNotesStore()
const player = usePlayerStore()

const emptyImage = "/empty.png"

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const selectedNoteId = ref<NoteId | null>(null)
const isActionSheetOpen = ref(false)

const isEmpty = computed(() => !store.isLoading && store.all.length === 0)
const rows = computed<readonly UiNoteRow[]>(() =>
  store.filtered.map((n) => ({
    id: n.id,
    text: n.text,
    trackId: n.trackId,
    author: "",
    source: "",
    language: "",
    tags: [],
    timeStart: n.timeStart,
    timeEnd: n.timeEnd,
    createdAt: n.createdAt,
  }))
)

const actionSheetButtons = computed(() => [
  {
    text: t("app.share"),
    handler: () => {
      void onShareNoteClicked()
    },
  },
  {
    text: t("app.copy"),
    handler: () => {
      void onCopyNoteClicked()
    },
  },
  {
    text: t("app.delete"),
    role: "destructive" as const,
    handler: () => {
      void onDeleteNoteClicked()
    },
  },
  {
    text: t("app.cancel"),
    role: "cancel" as const,
  },
])

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onQuery(next: string): Promise<void> {
  await store.setQuery(next)
}

async function onNoteClicked(noteId: string): Promise<void> {
  await Haptics.impact({ style: ImpactStyle.Light })
  selectedNoteId.value = noteId as NoteId
  isActionSheetOpen.value = true
}

function currentNote() {
  return store.all.find((n) => n.id === selectedNoteId.value) ?? null
}

async function onCopyNoteClicked(): Promise<void> {
  const note = currentNote()
  if (!note) return
  try {
    await navigator.clipboard.writeText(note.text)
  } catch {
    // Non-fatal; insecure origin or permission denied.
  }
}

async function onShareNoteClicked(): Promise<void> {
  const note = currentNote()
  if (!note) return
  if (typeof navigator !== "undefined" && "share" in navigator) {
    try {
      await (navigator as Navigator & { share: (d: ShareData) => Promise<void> }).share({
        text: note.text,
      })
    } catch {
      // User cancelled — ignore.
    }
  }
}

async function onDeleteNoteClicked(): Promise<void> {
  const id = selectedNoteId.value
  if (!id) return
  await store.remove(id)
}

onMounted(() => {
  void store.refresh()
})
</script>
