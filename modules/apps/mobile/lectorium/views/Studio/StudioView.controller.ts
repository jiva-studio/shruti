import { computed, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { onIonViewWillEnter } from "@ionic/vue"
import router from "@lectorium/router/index.js"
import { loadTranscript } from "@usecases"
import type { LanguageCode, NoteId, TrackId } from "@lib/domain/core.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant, type Track } from "@lib/domain/track.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import {
  preferredContentLanguage,
  resolveTrackTitle as resolveTitleForLang,
} from "@lib/domain/services/localizedName.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { resolveShareArtifact } from "@lectorium/services/resolveShareArtifact.js"
import { useToast } from "@kit/composables"
import { withProgressLabels } from "@lectorium/services/withProgressLabels.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import {
  useStudioHandoffStore,
  type StudioHandoff,
} from "@lectorium/stores/useStudioHandoffStore.js"

interface CitationContext {
  trackId: string
  startMs: number
  endMs: number
  caption?: string
}

export interface StudioControllerReturn {
  /** True until the note/track or citation has been resolved. */
  loading: Ref<boolean>
  /** Editable quote text — two-way bound to the textarea. */
  editedText: Ref<string>
  /** Editable title — two-way bound to the title input. Optional;
   *  empty string means "don't render a title-card overlay". */
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
  const { t } = useI18n()
  // Singleton import — see NotesView.controller for the why.
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const purchases = usePurchasesStore()
  const paywall = usePaywallStore()
  const toast = useToast()
  const shareJob = useShareJobStore()
  const notes = useNotesStore()
  const studioHandoff = useStudioHandoffStore()

  const note = ref<Note | null>(null)
  const citation = ref<CitationContext | null>(null)
  const track = ref<Track | null>(null)
  const editedText = ref<string>("")
  const editedTitle = ref<string>("")
  const loading = ref<boolean>(true)
  const busy = ref<boolean>(false)
  const status = ref<string>("")

  const isCitationMode = computed<boolean>(() => citation.value !== null)

  // The track's content language (a library language it has), so the title and
  // the extracted transcript text match the language the lecture is shown in.
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

  /**
   * Studio is a Pro feature. Non-subscribers landing here (deeplink or
   * stale share-menu entry) get the paywall and are bounced back to
   * Notes — opening the dialog at the same time keeps the journey
   * obvious.
   */
  function guardPro(): boolean {
    if (purchases.isSubscribed) return true
    paywall.requestOpen("notesStudio")
    void router.replace("/tabs/notes")
    return false
  }

  /**
   * Pull the transcript-overlap text for the citation, mirroring
   * `saveCitationAsNote`'s extraction so Studio + Save-as-Note seed
   * the editor with the same words. Returns empty string when the
   * transcript can't be loaded or there's no overlap — caller falls
   * back to the chip caption.
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
      const parts: string[] = []
      for (const b of result.value.transcript.blocks) {
        if (b.type !== "sentence") continue
        if (b.end >= c.startMs && b.start <= c.endMs) {
          const trimmed = b.text.trim()
          if (trimmed) parts.push(trimmed)
        }
      }
      return parts.join(" ")
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
    // Pre-fill the editor with the previously-saved Studio edit (if
    // any), otherwise the original quote. Stays in sync between
    // sessions because we write back to meta on every render.
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

    const seeded = (await extractCitationText(c)) || (c.caption ?? "")
    editedText.value = seeded
    editedTitle.value = ""
  }

  async function load(handoff: StudioHandoff): Promise<void> {
    loading.value = true
    // The page is cached by IonRouterOutlet, so refs survive across
    // entries. Reset both mode refs before dispatching — otherwise a
    // citation opened first leaves `citation.value` set, keeping
    // `isCitationMode` true when a note is opened next, and `onDownload`
    // would export the stale citation segment instead of the note.
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

  function readStudioMeta(
    meta: NoteMeta | null | undefined
  ): { text?: string; title?: string } | null {
    if (!meta || typeof meta !== "object") return null
    const studio = (meta as Record<string, unknown>).studio
    if (!studio || typeof studio !== "object") return null
    return studio as { text?: string; title?: string }
  }

  function localVideoFilename(id: string): string {
    return `share-video-note-${id}.mp4`
  }

  function citationVideoFilename(videoId: string): string {
    return `share-video-cit-${videoId}.mp4`
  }

  /**
   * Stable opaque idempotency key for a citation-mode render. The service
   * uses it as both S3-cache key and request dedupe key, so it must be
   * deterministic in (trackId, startMs, endMs). SHA-256 → 28 hex chars
   * (+ `cit_` prefix = 32 total) fits the server's 64-char regex.
   */
  async function citationVideoId(c: CitationContext): Promise<string> {
    const input = `${c.trackId}|${c.startMs}|${c.endMs}`
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
    const bytes = Array.from(new Uint8Array(buf))
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
    return `cit_${hex.slice(0, 28)}`
  }

  /**
   * Persist editor text + title into `note.meta.studio`. Only writes
   * when at least one value actually changed. No-op in citation mode.
   */
  async function persistEditIfChanged(
    current: Note,
    nextText: string,
    nextTitle: string
  ): Promise<Note> {
    const existing = readStudioMeta(current.meta)
    const existingTitle = existing?.title ?? ""
    if ((existing?.text ?? null) === nextText && existingTitle === nextTitle) {
      return current
    }

    const baseMeta: NoteMeta = (current.meta ?? {}) as NoteMeta
    const nextStudio: { text?: string; title?: string } = { ...(existing ?? {}), text: nextText }
    if (nextTitle.length > 0) nextStudio.title = nextTitle
    else delete nextStudio.title
    const nextMeta: NoteMeta = { ...baseMeta, studio: nextStudio }
    const updated = await notes.update({ id: current.id, meta: nextMeta })
    if (!updated.ok) {
      reportError("studio-note", updated.error)
      return current
    }
    return updated.value
  }

  async function onDownload(): Promise<void> {
    if (!track.value || busy.value) return
    if (!isCitationMode.value && !note.value) return
    if (isCitationMode.value && !citation.value) return

    const trimmed = editedText.value.trim()
    if (trimmed.length === 0) {
      await toast.error(t("studio.errorEmpty"))
      return
    }
    const trimmedTitle = editedTitle.value.trim()
    const variant = pickPlayableVariant(track.value)
    if (!variant?.audio) {
      await toast.error(t("studio.errorNoAudio"))
      return
    }

    let videoId: string
    let filename: string
    let startMs: number
    let endMs: number
    if (isCitationMode.value && citation.value) {
      videoId = await citationVideoId(citation.value)
      filename = citationVideoFilename(videoId)
      startMs = citation.value.startMs
      endMs = citation.value.endMs
    } else if (note.value) {
      videoId = note.value.id
      filename = localVideoFilename(note.value.id)
      startMs = note.value.timeStart
      endMs = note.value.timeEnd
    } else {
      return
    }

    if (!shareJob.tryStart("video", videoId)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    busy.value = true
    status.value = t("studio.preparing")
    try {
      if (!isCitationMode.value && note.value) {
        note.value = await persistEditIfChanged(note.value, trimmed, trimmedTitle)
      }

      // Shared cache → CDN-probe → cut+poll → download pipeline. The
      // video render is slow, so we drive the timed "rendering…" labels
      // via wrapCut and flip to "downloading…" right before the fetch.
      const localUri = await resolveShareArtifact({
        cache: app.excerptCache,
        filename,
        predictedUrl: buildServerUrl(app.activeServer.value, `public/share/video/${videoId}.mp4`),
        // Returns void on purpose: the video renderer is async and its
        // response carries no ready file, so we always poll predictedUrl.
        cut: async () => {
          await app.shareVideoService.cut({
            sourceKey: variant.audio!.path,
            startMs,
            endMs,
            text: trimmed,
            lang: variant.language,
            theme: "prabhupada",
            videoId,
            title: trimmedTitle.length > 0 ? trimmedTitle : undefined,
          })
        },
        wrapCut: (work) =>
          withProgressLabels(
            work,
            [
              { atMs: 5_000, label: t("studio.rendering") },
              { atMs: 45_000, label: t("studio.almostReady") },
              { atMs: 90_000, label: t("studio.stillWorking") },
            ],
            (label) => {
              status.value = label
            }
          ),
        onBeforeDownload: () => {
          status.value = t("studio.downloading")
        },
      })

      status.value = ""
      await app.shareService.share({
        url: localUri,
        title: trackTitle.value,
        dialogTitle: t("studio.shareDialog"),
      })
    } catch (e) {
      console.error("[studio] download failed:", e)
      await toast.error(t("studio.errorGeneric"))
    } finally {
      busy.value = false
      status.value = ""
      shareJob.finish()
    }
  }

  // `onIonViewWillEnter` instead of `onMounted` — Ionic's IonRouterOutlet
  // caches the page component, so `onMounted` fires only on the FIRST
  // visit. A user who opens Studio for note A, goes back, then opens
  // Studio for citation B would see note A still loaded. WillEnter
  // fires every time the page becomes the active route.
  onIonViewWillEnter(async () => {
    if (!guardPro()) return
    // Single source of truth: every Studio entry point writes here
    // before pushing /tabs/studio. Empty slot → deep-link or stale
    // navigation; bounce back to Notes.
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
    busy,
    status,
    trackTitle,
    onDownload,
  }
}
