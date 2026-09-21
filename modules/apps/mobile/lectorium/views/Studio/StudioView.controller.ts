import { computed, ref, type ComputedRef, type Ref } from "vue"
import { onIonViewWillEnter } from "@ionic/vue"
import router from "@lectorium/router/index.js"
import { loadTranscript } from "@usecases"
import type { LanguageCode, NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { type Track } from "@lib/domain/track.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useShareBackgroundOnLeave } from "@lectorium/composables/useShareBackgroundOnLeave.js"
import {
  preferredContentLanguage,
  resolveTrackTitle as resolveTitleForLang,
} from "@lib/domain/services/localizedName.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import {
  useStudioHandoffStore,
  type StudioHandoff,
} from "@lectorium/stores/useStudioHandoffStore.js"
import { joinOverlappingSentences, readStudioMeta, type CitationContext } from "./studioContent.js"
import { useStudioShare } from "./useStudioShare.js"

export interface StudioControllerReturn {
  /** True until the note/track or citation has been resolved. */
  loading: Ref<boolean>
  /** Editable quote text — two-way bound to the textarea. */
  editedText: Ref<string>
  /** Editable title — two-way bound to the title input. An empty string means
   *  "don't render a title-card overlay". */
  editedTitle: Ref<string>
  /** True while we're rendering / downloading / sharing. */
  busy: Ref<boolean>
  /** User-visible status under the button while `busy` is true. */
  status: Ref<string>
  /** Track-resolved title for the share-sheet title. */
  trackTitle: ComputedRef<string | undefined>
  /** Trigger the single-button download/share flow. */
  onDownload: () => Promise<void>
}

export function useStudioController(): StudioControllerReturn {
  // Singleton import — see NotesView.controller for the why.
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const purchases = usePurchasesStore()
  const studioHandoff = useStudioHandoffStore()

  const note = ref<Note | null>(null)
  const citation = ref<CitationContext | null>(null)
  const track = ref<Track | null>(null)
  const editedText = ref<string>("")
  const editedTitle = ref<string>("")
  const loading = ref<boolean>(true)

  // A cold render polls for minutes and the page keeps running through it, so
  // walking away would otherwise hold the app-wide share slot with nothing on
  // screen to say so.
  useShareBackgroundOnLeave()

  // The track's content language (a library language it has), so the title and
  // the extracted transcript text match the language it is shown in.
  function contentLangOf(t: Track | null): LanguageCode {
    return (
      (t ? preferredContentLanguage(t, libraryLanguages.value, appLanguage.value) : undefined) ??
      appLanguage.value
    )
  }

  const trackTitle = computed<string | undefined>(() =>
    track.value
      ? (resolveTitleForLang(track.value, contentLangOf(track.value)) ?? undefined)
      : undefined
  )

  const share = useStudioShare({ track, note, citation, editedText, editedTitle, trackTitle })

  /**
   * Studio is a Pro feature; a non-subscriber landing here is bounced back to
   * Notes with the paywall open. Async because this page ejects the user:
   * "not known yet" must never `router.replace`, and that is exactly what
   * `isSubscribed` reads for a subscriber during the entitlement reconcile.
   */
  async function guardPro(): Promise<boolean> {
    if (await purchases.ensurePro("notesStudio")) return true
    void router.replace("/tabs/notes")
    return false
  }

  /**
   * The transcript-overlap text for the citation, mirroring
   * `saveCitationAsNote`'s extraction so Studio and Save-as-Note seed the
   * editor with the same words. Empty when there is no overlap or the
   * transcript cannot be loaded — the caller falls back to the chip caption.
   */
  async function extractCitationText(c: CitationContext): Promise<string> {
    try {
      const result = await loadTranscript(
        {
          trackId: c.trackId as TrackId,
          preferredLanguage: contentLangOf(track.value) as LanguageCode,
        },
        { transcripts: app.repositories().transcripts }
      )
      if (!result.ok) return ""
      return joinOverlappingSentences(result.value.transcript.blocks, c.startMs, c.endMs)
    } catch (e) {
      console.warn("[studio] citation transcript extract failed:", e)
      return ""
    }
  }

  async function loadNote(noteId: NoteId): Promise<void> {
    const n = await app.repositories().notes.getById(noteId)
    if (!n) {
      void router.replace("/tabs/notes")
      return
    }
    note.value = n
    // The previously-saved Studio edit, else the original quote. Stays in sync
    // between sessions because every render writes back to meta.
    const savedStudio = readStudioMeta(n.meta)
    editedText.value = savedStudio?.text ?? n.text
    editedTitle.value = savedStudio?.title ?? ""

    const tracksById = await app.repositories().tracks.getByIds([n.trackId as TrackId])
    track.value = tracksById.get(n.trackId as TrackId) ?? null
  }

  async function loadCitation(c: CitationContext): Promise<void> {
    citation.value = c
    const tracksById = await app.repositories().tracks.getByIds([c.trackId as TrackId])
    track.value = tracksById.get(c.trackId as TrackId) ?? null

    editedText.value = (await extractCitationText(c)) || (c.caption ?? "")
    editedTitle.value = ""
  }

  async function load(handoff: StudioHandoff): Promise<void> {
    loading.value = true
    // The page is cached by IonRouterOutlet, so both mode refs are reset
    // before dispatching: a citation opened first would otherwise keep the
    // page in citation mode when a note is opened next.
    note.value = null
    citation.value = null
    try {
      if (handoff.kind === "citation") {
        await loadCitation({
          trackId: handoff.trackId,
          startMs: handoff.startMs,
          endMs: handoff.endMs,
          caption: handoff.caption,
        })
      } else {
        await loadNote(handoff.noteId as NoteId)
      }
    } finally {
      loading.value = false
    }
  }

  // Not `onMounted`: IonRouterOutlet caches the page, so that fires only on the
  // first visit and a second entry would still show the first subject.
  onIonViewWillEnter(async () => {
    if (!(await guardPro())) return
    // Every Studio entry point writes the handoff before pushing the route.
    // An empty slot is a deep link or a stale navigation.
    const handoff = studioHandoff.consume()
    if (!handoff) {
      void router.replace("/tabs/notes")
      return
    }
    await load(handoff)
  })

  return {
    loading,
    editedText,
    editedTitle,
    busy: share.busy,
    status: share.status,
    trackTitle,
    onDownload: share.onDownload,
  }
}
