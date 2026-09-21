import { ref, type Ref } from "vue"
import type { Note } from "@lib/domain/note.js"
import type { Track } from "@lib/domain/track.js"
import type { NoteShareContext } from "@usecases/notes/formatNoteShare.js"
import { formatReference } from "@lib/domain/services/references.js"
import { resolveLocalizedName } from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { useTranscriptStore } from "@shruti/stores/useTranscriptStore.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useAskSadhuFromTranscript } from "@shruti/composables/useAskSadhuFromTranscript.js"
import { useTranscriptSelectionActions } from "@shruti/composables/transcript/useTranscriptSelectionActions.js"
import type { SelectionActionEvent } from "@shruti/composables/transcript/useTranscriptSelectionActions.js"
import type {
  ExistingNoteSelection,
  NoteTappedEvent,
  TextSelectedEvent,
} from "@ui/features/transcript/index.js"

export interface TranscriptNotesDeps {
  readonly getTrack: () => Track | null | undefined
  readonly title: Ref<string>
  readonly author: Ref<string>
  readonly onError: (key: string) => void
}

export interface TranscriptNotes {
  /** Saved notes for the open track — drives the wavy-underline highlight. */
  readonly notes: Ref<readonly Note[]>
  refresh: () => Promise<void>
  readonly lastTextSelectedEvent: Ref<TextSelectedEvent | undefined>
  readonly lastNoteTappedEvent: Ref<ExistingNoteSelection | undefined>
  onTextSelected: (event: TextSelectedEvent) => void
  onNoteTapped: (event: NoteTappedEvent) => void
  onSelectionAction: (event: SelectionActionEvent) => Promise<void>
  onSelectionDismissed: () => void
}

/**
 * Notes over the open transcript and the selection popover that acts on them:
 * copy, bookmark, share, delete, and "ask Sadhu about this passage".
 */
export function useTranscriptNotes(deps: TranscriptNotesDeps): TranscriptNotes {
  const app = useShruti()
  const transcriptStore = useTranscriptStore()
  const dictionaries = useDictionariesStore()
  const notesStore = useNotesStore()
  const appLanguage = useAppLanguage()

  const notesForTrack = ref<readonly Note[]>([])
  // The popover lives at App.vue level as a sibling of TranscriptDialog.
  // Drag-select fills `lastTextSelectedEvent`; tapping an existing highlight
  // fills `lastNoteTappedEvent`. Clearing either one closes the popover.
  const lastTextSelectedEvent = ref<TextSelectedEvent>()
  const lastNoteTappedEvent = ref<ExistingNoteSelection>()

  async function refreshNotesForTrack(): Promise<void> {
    const id = transcriptStore.trackId
    if (!id) {
      notesForTrack.value = []
      return
    }
    try {
      notesForTrack.value = await app.repositories().notes.listByTrack(id)
    } catch {
      notesForTrack.value = []
    }
  }

  function buildShareTrackContext(): NoteShareContext["track"] | undefined {
    const track = deps.getTrack()
    if (!track) return undefined
    const lang = appLanguage.value
    const location = track.locationId ? dictionaries.locationsById.get(track.locationId) : undefined
    const locationName = resolveLocalizedName(location, lang)
    const reference =
      track.references.length > 0
        ? formatReference(track.references[0]!, dictionaries.sourcesById, lang)
        : undefined
    return {
      title: deps.title.value || undefined,
      authorName: deps.author.value || undefined,
      date: track.date || undefined,
      locationName,
      reference,
    }
  }

  const askSadhu = useAskSadhuFromTranscript({
    getTrack: () => deps.getTrack(),
    getShareContext: buildShareTrackContext,
    onError: deps.onError,
  })

  const selectionActions = useTranscriptSelectionActions({
    getTrackId: () => transcriptStore.trackId,
    getNotes: () => app.repositories().notes,
    getUnitOfWork: () => app.repositories().unitOfWork,
    shareService: app.shareService,
    getShareTrackContext: buildShareTrackContext,
    onNoteCreated: () => {
      // Refresh both the dialog's in-memory note list (drives the
      // wavy-underline highlight on the transcript) and the global
      // notes store (drives the Notes page list). Without this the new
      // bookmark stays invisible until the user re-opens the app.
      void refreshNotesForTrack()
      void notesStore.refresh()
    },
    onNoteDeleted: () => {
      // Same refresh dance as onNoteCreated: drop the underline from the
      // transcript and remove the row from the Notes tab.
      void refreshNotesForTrack()
      void notesStore.refresh()
    },
    onError: deps.onError,
    onAskRequested: askSadhu,
  })

  // Selection lifecycle. The two events are mutually exclusive — opening
  // one always clears the other — so the popover's `selection`/`existing`
  // props never both light up at once.
  function onTextSelected(event: TextSelectedEvent): void {
    lastNoteTappedEvent.value = undefined
    lastTextSelectedEvent.value = event
  }

  function onNoteTapped(event: NoteTappedEvent): void {
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = { noteIds: event.noteIds, event: event.event }
  }

  async function onSelectionAction(event: SelectionActionEvent): Promise<void> {
    // Clear refs first — that flips the popover to `isOpen=false`
    // immediately, so its dismiss animation runs in parallel with the
    // action's async work (DB write for bookmark, chat session for ask).
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = undefined
    await selectionActions.perform(event)
  }

  function onSelectionDismissed(): void {
    lastTextSelectedEvent.value = undefined
    lastNoteTappedEvent.value = undefined
  }

  return {
    notes: notesForTrack,
    refresh: refreshNotesForTrack,
    lastTextSelectedEvent,
    lastNoteTappedEvent,
    onTextSelected,
    onNoteTapped,
    onSelectionAction,
    onSelectionDismissed,
  }
}
