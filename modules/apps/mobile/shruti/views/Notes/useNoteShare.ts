import { actionSheetController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { formatNoteShare } from "@usecases/notes/formatNoteShare.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { SHORT_POLL_TIMEOUT_MS } from "@lib/chat/utils/pollUntilReady.js"
import { resolveShareArtifact } from "@shruti/services/resolveShareArtifact.js"
import { useToast } from "@kit/composables"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useStudioHandoffStore } from "@shruti/stores/useStudioHandoffStore.js"
import type { UseNoteTrackContextReturn } from "./useNoteTrackContext.js"
import { useShareHandoff } from "./useShareHandoff.js"

export interface UseNoteShareReturn {
  onCopyNoteClicked: () => Promise<void>
  onShareNoteClicked: () => Promise<void>
  presentShareMenu: () => Promise<void>
  onOpenInStudioClicked: () => void
}

/** Canonical filename of a previously-shared excerpt for this note. */
function localExcerptPath(noteId: NoteId): string {
  return `share-audio-note-${noteId}.mp3`
}

export function useNoteShare(
  currentNote: () => Note | null,
  tracks: UseNoteTrackContextReturn
): UseNoteShareReturn {
  const { t } = useI18n()
  const { shareService, shareAudioService, activeServer, haptics, excerptCache } = useShruti()
  const appLanguage = useAppLanguage()
  const toast = useToast()
  const { runShareWorkflow } = useShareHandoff()
  const purchases = usePurchasesStore()
  const studioHandoff = useStudioHandoffStore()

  function buildShareText(): string | null {
    const note = currentNote()
    if (!note) return null
    const { track, author, location } = tracks.contextFor(note.trackId as TrackId)
    return formatNoteShare({
      text: note.text,
      locale: appLanguage.value,
      timeStart: note.timeStart,
      timeEnd: note.timeEnd,
      track: track
        ? {
            title: tracks.trackTitle(track),
            authorName: tracks.authorName(author),
            date: track.date || undefined,
            locationName: tracks.locationName(location),
            reference: tracks.reference(track),
          }
        : undefined,
    })
  }

  async function onCopyNoteClicked(): Promise<void> {
    const payload = buildShareText()
    if (!payload) return
    await shareService.copyToClipboard(payload)
  }

  async function onShareNoteClicked(): Promise<void> {
    const payload = buildShareText()
    if (!payload) return
    await shareService.share({ text: payload })
  }

  async function onShareNoteAudioClicked(): Promise<void> {
    const note = currentNote()
    if (!note) return
    const { track } = tracks.contextFor(note.trackId as TrackId)
    const variant = track ? pickPlayableVariant(track) : null
    if (!track || !variant?.audio) {
      await toast.error(t("notes.shareAudioErrorNoAudio"))
      return
    }
    const audioPath = variant.audio.path

    await runShareWorkflow({
      jobKind: "audio",
      noteId: note.id,
      initialLabel: t("notes.shareAudioPreparing"),
      errorLabel: t("notes.shareAudioErrorGeneric"),
      workFn: () =>
        resolveShareArtifact({
          cache: excerptCache,
          filename: localExcerptPath(note.id),
          predictedUrl: buildServerUrl(activeServer.value, `public/shares/audio/${note.id}.mp3`),
          cut: () =>
            shareAudioService.cut({
              sourceKey: audioPath,
              startMs: note.timeStart,
              endMs: note.timeEnd,
              excerptId: note.id,
            }),
          // An audio cut takes seconds; the 8-minute Studio-video default
          // would hold the app-wide share slot for that long on a dead URL.
          pollTimeoutMs: SHORT_POLL_TIMEOUT_MS,
        }),
      openShareSheet: (uri) =>
        shareService.share({
          url: uri,
          title: tracks.trackTitle(track),
          dialogTitle: t("notes.shareAudioDialog"),
        }),
    })
  }

  /**
   * Studio entry point. Pro-gated — the editor re-checks the gate on mount so
   * a stale "subscribed" cache cannot slip through.
   */
  function onOpenInStudioClicked(): void {
    const note = currentNote()
    if (!note) return
    void (async () => {
      if (!(await purchases.ensurePro("notesStudio"))) return
      studioHandoff.setPending({ kind: "note", noteId: note.id })
      void router.push("/tabs/studio")
    })()
  }

  /** Second-level share sheet (text / audio / video), stacked on top of the
   *  note's own sheet. */
  async function presentShareMenu(): Promise<void> {
    void haptics.impact("light")
    const sheet = await actionSheetController.create({
      header: t("notes.share"),
      buttons: [
        {
          text: t("notes.shareText"),
          handler: () => {
            void onShareNoteClicked()
          },
        },
        {
          text: t("notes.shareAudio"),
          handler: () => {
            void onShareNoteAudioClicked()
          },
        },
        {
          text: t("notes.shareVideo"),
          cssClass: "action-sheet-pro",
          handler: () => {
            onOpenInStudioClicked()
          },
        },
        { text: t("app.close"), role: "cancel" },
      ],
    })
    await sheet.present()
  }

  return { onCopyNoteClicked, onShareNoteClicked, presentShareMenu, onOpenInStudioClicked }
}
