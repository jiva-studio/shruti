import { ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import type { Note } from "@lib/domain/note.js"
import { buildServerUrl } from "@lib/domain/servers.js"
import { pickPlayableVariant, type Track } from "@lib/domain/track.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { resolveShareArtifact } from "@lectorium/services/resolveShareArtifact.js"
import { studioVideoArtifact } from "@lectorium/services/shareArtifactKeys.js"
import { ShareVideoRateLimitError } from "@ports/app/index.js"
import { useToast } from "@kit/composables"
import { withProgressLabels } from "@lectorium/services/withProgressLabels.js"
import { useNotesStore } from "@lectorium/stores/useNotesStore.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import { nextStudioMeta, studioShareRange, type CitationContext } from "./studioContent.js"

export interface StudioShareSubject {
  track: Ref<Track | null>
  note: Ref<Note | null>
  citation: Ref<CitationContext | null>
  editedText: Ref<string>
  editedTitle: Ref<string>
  trackTitle: Ref<string | undefined>
}

export interface UseStudioShareReturn {
  busy: Ref<boolean>
  status: Ref<string>
  onDownload: () => Promise<void>
}

interface Plan {
  readonly videoId: string
  readonly filename: string
  readonly sourceKey: string
  readonly lang: string
  readonly startMs: number
  readonly endMs: number
  readonly text: string
  readonly title: string
}

export function useStudioShare(subject: StudioShareSubject): UseStudioShareReturn {
  const { t } = useI18n()
  const app = useLectorium()
  const toast = useToast()
  const notes = useNotesStore()
  const shareJob = useShareJobStore()

  const busy = ref<boolean>(false)
  const status = ref<string>("")

  /** The video key carries the edited caption and title: the render depends on
   *  them, and the artifact cache answers before anyone is asked. */
  async function buildPlan(): Promise<Plan | null> {
    const track = subject.track.value
    if (!track) return null
    const text = subject.editedText.value.trim()
    if (text.length === 0) {
      await toast.error(t("studio.errorEmpty"))
      return null
    }
    const variant = pickPlayableVariant(track)
    const audio = variant?.audio
    if (!variant || !audio) {
      await toast.error(t("studio.errorNoAudio"))
      return null
    }
    const range = studioShareRange(subject.note.value, subject.citation.value)
    if (!range) return null
    const title = subject.editedTitle.value.trim()
    const { videoId, filename } = await studioVideoArtifact(range.subject, { text, title })
    return {
      videoId,
      filename,
      sourceKey: audio.path,
      lang: variant.language,
      startMs: range.startMs,
      endMs: range.endMs,
      text,
      title,
    }
  }

  async function persistEdit(plan: Plan): Promise<void> {
    const current = subject.note.value
    if (!current || subject.citation.value) return
    const meta = nextStudioMeta(current.meta, plan.text, plan.title)
    if (!meta) return
    const updated = await notes.update({ id: current.id, meta })
    if (updated.ok) subject.note.value = updated.value
    else reportError("studio-note", updated.error)
  }

  // The video render is slow, so the timed labels run off wrapCut and flip to
  // "downloading…" right before the fetch.
  async function renderAndShare(plan: Plan): Promise<void> {
    const localUri = await resolveShareArtifact({
      cache: app.excerptCache,
      filename: plan.filename,
      predictedUrl: buildServerUrl(
        app.activeServer.value,
        `public/share/video/${plan.videoId}.mp4`
      ),
      // Returns void on purpose: the renderer is async and its response
      // carries no ready file, so predictedUrl is always polled.
      cut: async () => {
        await app.shareVideoService.cut({
          sourceKey: plan.sourceKey,
          startMs: plan.startMs,
          endMs: plan.endMs,
          text: plan.text,
          lang: plan.lang,
          theme: "prabhupada",
          videoId: plan.videoId,
          title: plan.title.length > 0 ? plan.title : undefined,
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
      title: subject.trackTitle.value,
      dialogTitle: t("studio.shareDialog"),
    })
  }

  // The daily bucket is a UTC day, so "try again" is advice that cannot work
  // until midnight UTC; the adapter has read the counters off the 429 already.
  async function reportFailure(e: unknown): Promise<void> {
    console.error("[studio] download failed:", e)
    if (e instanceof ShareVideoRateLimitError) {
      await toast.error(t("studio.errorRateLimited", { current: e.current, limit: e.limit }))
      return
    }
    await toast.error(t("studio.errorGeneric"))
  }

  async function onDownload(): Promise<void> {
    if (busy.value) return
    const plan = await buildPlan()
    if (!plan) return
    if (!shareJob.tryStart("video", plan.videoId)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }
    busy.value = true
    status.value = t("studio.preparing")
    try {
      await persistEdit(plan)
      await renderAndShare(plan)
    } catch (e) {
      await reportFailure(e)
    } finally {
      busy.value = false
      status.value = ""
      shareJob.finish()
    }
  }

  return { busy, status, onDownload }
}
