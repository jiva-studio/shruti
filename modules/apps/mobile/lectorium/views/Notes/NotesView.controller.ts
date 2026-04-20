import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { Haptics, ImpactStyle } from "@capacitor/haptics"
import { useI18n } from "vue-i18n"
import type { UiNoteRow } from "@ui/features/notes/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import type { NoteId } from "@lib/domain/core.js"

export interface NotesActionSheetButton {
  readonly text: string
  readonly role?: "destructive" | "cancel"
  readonly handler?: () => void
}

export interface NotesControllerReturn {
  rows: ComputedRef<readonly UiNoteRow[]>
  isEmpty: ComputedRef<boolean>
  query: ComputedRef<string>
  isActionSheetOpen: Ref<boolean>
  actionSheetButtons: ComputedRef<readonly NotesActionSheetButton[]>
  onQuery: (next: string) => Promise<void>
  onNoteClicked: (noteId: string) => Promise<void>
}

export function useNotesController(): NotesControllerReturn {
  const { t } = useI18n()
  const store = useNotesStore()
  const { shareService } = useLectorium()

  const selectedNoteId = ref<NoteId | null>(null)
  const isActionSheetOpen = ref(false)

  const query = computed(() => store.query)
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

  function currentNote() {
    return store.all.find((n) => n.id === selectedNoteId.value) ?? null
  }

  async function onCopyNoteClicked(): Promise<void> {
    const note = currentNote()
    if (!note) return
    await shareService.copyToClipboard(note.text)
  }

  async function onShareNoteClicked(): Promise<void> {
    const note = currentNote()
    if (!note) return
    await shareService.share({ text: note.text })
  }

  async function onDeleteNoteClicked(): Promise<void> {
    const id = selectedNoteId.value
    if (!id) return
    await store.remove(id)
  }

  const actionSheetButtons = computed<readonly NotesActionSheetButton[]>(() => [
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
      role: "destructive",
      handler: () => {
        void onDeleteNoteClicked()
      },
    },
    {
      text: t("app.cancel"),
      role: "cancel",
    },
  ])

  async function onQuery(next: string): Promise<void> {
    await store.setQuery(next)
  }

  async function onNoteClicked(noteId: string): Promise<void> {
    await Haptics.impact({ style: ImpactStyle.Light })
    selectedNoteId.value = noteId as NoteId
    isActionSheetOpen.value = true
  }

  onMounted(() => {
    void store.refresh()
  })

  return {
    rows,
    isEmpty,
    query,
    isActionSheetOpen,
    actionSheetButtons,
    onQuery,
    onNoteClicked,
  }
}
