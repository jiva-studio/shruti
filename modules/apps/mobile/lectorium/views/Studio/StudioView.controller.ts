import { computed, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { useRoute, useRouter } from "vue-router"
import type { NoteId, TrackId } from "@lib/domain/core.js"
import type { Note, NoteMeta } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import type { Track } from "@lib/domain/track.js"
import type { TrackVariant } from "@lib/domain/trackVariant.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { resolveTrackTitle as resolveTitleForLang } from "@lectorium/composables/resolveLocalized.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { pollUntilReady } from "@lectorium/services/pollUntilReady.js"
import { useToast } from "@lectorium/services/useToast.js"
import { withProgressLabels, type LabelStep } from "@lectorium/services/withProgressLabels.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { usePaywallStore } from "@lectorium/stores/usePaywallStore.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"

export interface StudioControllerReturn {
  /** True until the note + track have been resolved (or failed). */
  loading: Ref<boolean>
  /** Current note; null until loaded / on missing id. */
  note: Ref<Note | null>
  /** Editable quote text — two-way bound to the textarea. */
  editedText: Ref<string>
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
  const route = useRoute()
  const router = useRouter()
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const purchases = usePurchasesStore()
  const paywall = usePaywallStore()
  const toast = useToast()
  const shareJob = useShareJobStore()
  const notes = useNotesStore()

  const noteId = computed<NoteId>(() => String(route.params.noteId) as NoteId)

  const note = ref<Note | null>(null)
  const track = ref<Track | null>(null)
  const editedText = ref<string>("")
  const loading = ref<boolean>(true)
  const busy = ref<boolean>(false)
  const status = ref<string>("")

  const trackTitle = computed<string | undefined>(() =>
    track.value ? (resolveTitleForLang(track.value, appLanguage.value) ?? undefined) : undefined
  )

  /**
   * Studio is a Pro feature. Non-subscribers landing here (deeplink or
   * stale share-menu entry) get the paywall and are bounced back to
   * Notes — opening the dialog at the same time keeps the journey
   * obvious.
   */
  function guardPro(): boolean {
    if (purchases.isSubscribed) return true
    paywall.requestOpen()
    void router.replace("/tabs/notes")
    return false
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      const n = await app.repositories().notes.getById(noteId.value)
      if (!n) {
        void router.replace("/tabs/notes")
        return
      }
      note.value = n
      // Pre-fill the editor with the previously-saved Studio edit (if any),
      // otherwise the original quote. Stays in sync between sessions
      // because we write back to meta on every render.
      const savedStudio = readStudioMeta(n.meta)?.text
      editedText.value = savedStudio ?? n.text

      const tracksById = await app.repositories().tracks.getByIds([n.trackId as TrackId])
      track.value = tracksById.get(n.trackId as TrackId) ?? null
    } finally {
      loading.value = false
    }
  }

  function readStudioMeta(meta: NoteMeta | null | undefined): { text?: string } | null {
    if (!meta || typeof meta !== "object") return null
    const studio = (meta as Record<string, unknown>).studio
    if (!studio || typeof studio !== "object") return null
    return studio as { text?: string }
  }

  /**
   * Pick the source audio variant. Mirrors NotesView controller's helper —
   * prefer "original", fall back to the first variant with audio.
   */
  function pickAudioVariant(t: Track): TrackVariant | null {
    const original = t.variants.find((v) => v.audio !== null && v.audio.kind === "original")
    if (original) return original
    return t.variants.find((v) => v.audio !== null) ?? null
  }

  function localVideoFilename(id: NoteId): string {
    return `share-video-note-${id}.mp4`
  }

  /**
   * Persist the editor text into `note.meta.studio.text`. Only writes
   * when the value actually changed — saves a needless round-trip
   * (and a notes-store refresh) on a "tap Download with no edits" path.
   * Returns the updated note so the caller can re-read its meta.
   */
  async function persistEditIfChanged(current: Note, nextText: string): Promise<Note> {
    const existing = readStudioMeta(current.meta)
    if ((existing?.text ?? null) === nextText) return current

    const baseMeta: NoteMeta = (current.meta ?? {}) as NoteMeta
    const nextMeta: NoteMeta = { ...baseMeta, studio: { ...(existing ?? {}), text: nextText } }
    const updated = await notes.update({ id: current.id, meta: nextMeta })
    if (!updated.ok) {
      // Not fatal — the share can still proceed using the local text —
      // but log it so dev builds notice. Keeping the throw out of the
      // happy path keeps the Download button responsive.
      console.warn("[studio] failed to persist edit:", updated.error)
      return current
    }
    return updated.value
  }

  async function onDownload(): Promise<void> {
    if (!note.value || !track.value || busy.value) return

    const trimmed = editedText.value.trim()
    if (trimmed.length === 0) {
      await toast.error(t("studio.errorEmpty"))
      return
    }
    const variant = pickAudioVariant(track.value)
    if (!variant?.audio) {
      await toast.error(t("studio.errorNoAudio"))
      return
    }

    if (!shareJob.tryStart("video", note.value.id)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    busy.value = true
    status.value = t("studio.preparing")
    try {
      note.value = await persistEditIfChanged(note.value, trimmed)

      const filename = localVideoFilename(note.value.id)
      // 1. Local cache hit — re-share immediately.
      let localUri = await app.excerptCache.findLocal(filename)
      if (!localUri) {
        // 2. CDN warm hit (prior render still on the bucket).
        const predictedUrl = buildServerUrl(
          app.activeServer.value,
          `public/share/video/${note.value.id}.mp4`
        )
        let publicUrl = (await app.excerptCache.probeRemote(predictedUrl)) ? predictedUrl : null

        // 3. Cold path — kick off the render and poll the predicted URL.
        if (!publicUrl) {
          const schedule: ReadonlyArray<LabelStep> = [
            { atMs: 5_000, label: t("studio.rendering") },
            { atMs: 45_000, label: t("studio.almostReady") },
            { atMs: 90_000, label: t("studio.stillWorking") },
          ]
          await withProgressLabels(
            (async () => {
              await app.shareVideoService.cut({
                sourceKey: variant.audio!.path,
                startMs: note.value!.timeStart,
                endMs: note.value!.timeEnd,
                text: trimmed,
                lang: variant.language,
                theme: "prabhupada",
                videoId: note.value!.id,
              })
              await pollUntilReady(predictedUrl)
            })(),
            schedule,
            (label) => {
              status.value = label
            }
          )
          publicUrl = predictedUrl
        }

        status.value = t("studio.downloading")
        localUri = await app.excerptCache.download({ url: publicUrl, filename })
      }

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

  onMounted(async () => {
    if (!guardPro()) return
    await load()
  })

  return {
    loading,
    note,
    editedText,
    busy,
    status,
    trackTitle,
    onDownload,
  }
}
