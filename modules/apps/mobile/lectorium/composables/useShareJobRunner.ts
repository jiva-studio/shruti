import { useI18n } from "vue-i18n"
import { loadingController } from "@ionic/vue"
import type { ShareOptions } from "@ports/app/index.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useToast } from "@kit/composables"
import { useShareJobStore, type ShareJobKind } from "@lectorium/stores/useShareJobStore.js"

/**
 * How long the user stays blocked behind the spinner before the work goes to
 * the background: long enough that a cached PDF or an already-downloaded
 * lecture settles under it, short enough that a cold render never holds the
 * whole UI.
 */
const HANDOFF_MS = 3_000

export type ShareReason = "no_transcript" | "no_audio" | "error"

/** What a share producer hands back: a ready artifact, or why there is none. */
export type Produced =
  | { readonly ok: true; readonly options: ShareOptions }
  | { readonly ok: false; readonly reason: ShareReason }

export type RunShareJob = (
  kind: ShareJobKind,
  jobKey: string,
  label: string,
  produce: (ctx: { setLabel: (message: string) => void }) => Promise<Produced>
) => Promise<void>

/**
 * Runs one long-running share at a time behind a blocking spinner, handing the
 * work to the background if it outlives {@link HANDOFF_MS}, then delivers the
 * artifact to the native share sheet.
 */
export function useShareJobRunner(): RunShareJob {
  const { t } = useI18n()
  const app = useLectorium()
  const toast = useToast()
  const shareJob = useShareJobStore()

  type Settled =
    | { readonly ok: true; readonly value: Produced }
    | { readonly ok: false; readonly err: unknown }

  async function run(
    kind: ShareJobKind,
    jobKey: string,
    label: string,
    produce: (ctx: { setLabel: (message: string) => void }) => Promise<Produced>
  ): Promise<void> {
    // Single long-running share at a time — shared with the audio/video/
    // chat-PDF jobs.
    if (!shareJob.tryStart(kind, jobKey)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    const modal = await loadingController.create({ message: label, spinner: "crescent" })
    await modal.present()
    let dismissed = false
    const close = async (): Promise<void> => {
      if (dismissed) return
      dismissed = true
      await modal.dismiss()
    }

    /** Hand the finished artifact to the share sheet, or say what went wrong. */
    const deliver = async (result: Produced): Promise<void> => {
      if (!result.ok) {
        await toast.error(
          result.reason === "no_transcript"
            ? t("search.share.noTranscript")
            : result.reason === "no_audio"
              ? t("search.share.noAudio")
              : t("search.share.error")
        )
        return
      }
      await app.shareService.share(result.options)
    }

    const work = produce({
      setLabel: (message) => {
        modal.message = message
      },
    })

    // Read through a function so TypeScript keeps the union: assigned from a
    // callback, a bare `let` narrows to `null` at the check below.
    let settled: Settled | null = null
    const readSettled = (): Settled | null => settled
    work.then(
      (value) => {
        settled = { ok: true, value }
      },
      (err: unknown) => {
        settled = { ok: false, err }
      }
    )
    // Every branch below either reads `settled` or attaches its own handler;
    // this only marks the promise handled so a rejection during the race is
    // not reported as unhandled.
    work.catch(() => undefined)

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, HANDOFF_MS)
      const stop = (): void => {
        clearTimeout(timer)
        resolve()
      }
      // `then(stop, stop)`, not `finally(stop)`: `finally` returns a derived
      // promise that re-raises the rejection, and nothing here consumes it.
      work.then(stop, stop)
    })

    const done = readSettled()

    // Still running: give the UI back and light the tab indicator, so the
    // "another share is in progress" refusal other surfaces hand out has a
    // visible cause. The job keeps the slot until it settles, on its own.
    if (done === null) {
      shareJob.markInBackground()
      await close()
      await toast.info(t("notes.shareInBackground"))
      work
        .then(deliver)
        .catch(async (err: unknown) => {
          console.warn("[share-track] failed", err)
          await toast.error(t("search.share.error"))
        })
        .finally(() => {
          shareJob.finish()
        })
      return
    }

    // Drop the spinner before the share sheet so they don't overlap.
    await close()
    try {
      if (done.ok) {
        await deliver(done.value)
      } else {
        console.warn("[share-track] failed", done.err)
        await toast.error(t("search.share.error"))
      }
    } catch (err) {
      console.warn("[share-track] failed", err)
      await toast.error(t("search.share.error"))
    } finally {
      shareJob.finish()
    }
  }

  return run
}
