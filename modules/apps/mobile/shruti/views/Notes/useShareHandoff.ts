import { loadingController } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { useToast } from "@kit/composables"
import type { NoteId } from "@lib/domain/core.js"
import { useShareJobStore, type ShareJobKind } from "@shruti/stores/useShareJobStore.js"

/** How long the user stays blocked behind the spinner before the work is
 *  handed to the background. */
const HANDOFF_MS = 3_000

type Settled = { ok: true; uri: string } | { ok: false; err: unknown } | null

export interface ShareWorkflowArgs {
  jobKind: ShareJobKind
  noteId: NoteId
  initialLabel: string
  workFn: () => Promise<string>
  openShareSheet: (localUri: string) => Promise<void>
  errorLabel: string
}

export interface UseShareHandoffReturn {
  runShareWorkflow: (args: ShareWorkflowArgs) => Promise<void>
}

/** Resolves once the work has settled or the handoff window is up. */
async function raceHandoff(work: Promise<string>): Promise<void> {
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
}

/**
 * Runs share work (cache → probe → cut+poll → download → share sheet) behind a
 * spinner for `HANDOFF_MS`, then releases the UI and lets the work finish in
 * the background — firing the system share sheet when it does.
 *
 * Single-slot guard via `useShareJobStore`: a second tap while a job runs gets
 * a "wait" toast, whichever note and whichever kind. The loading modal is
 * owned here rather than via `withLoading` because its lifetime is the handoff
 * window, not the work.
 */
export function useShareHandoff(): UseShareHandoffReturn {
  const { t } = useI18n()
  const toast = useToast()
  const shareJob = useShareJobStore()

  async function runShareWorkflow(args: ShareWorkflowArgs): Promise<void> {
    if (!shareJob.tryStart(args.jobKind, args.noteId)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    const modal = await loadingController.create({
      message: args.initialLabel,
      spinner: "crescent",
    })
    await modal.present()

    const work = args.workFn()
    let settled: Settled = null
    work.then(
      (uri) => {
        settled = { ok: true, uri }
      },
      (err) => {
        settled = { ok: false, err }
      }
    )
    // Suppress unhandled-rejection: every consumer below either reads
    // `settled` or attaches its own .catch in the background branch.
    work.catch(() => undefined)

    await raceHandoff(work)

    const outcome = settled as Settled
    if (outcome) {
      await modal.dismiss()
      if (outcome.ok) {
        await args.openShareSheet(outcome.uri).catch(() => toast.error(args.errorLabel))
      }
      shareJob.finish()
      if (!outcome.ok) await toast.error(args.errorLabel)
      return
    }

    // Still running. The tab spinner goes on only now, so the fast paths above
    // never flicker it.
    shareJob.markInBackground()
    await modal.dismiss()
    await toast.info(t("notes.shareInBackground"))
    work
      .then(async (uri) => {
        try {
          await args.openShareSheet(uri)
        } catch (e) {
          // The file is on the CDN; the next tap on the same note is a
          // cache-hit, so a failed sheet is not worth a toast.
          console.warn("background share-sheet failed:", e)
        }
      })
      .catch(async () => {
        await toast.error(args.errorLabel)
      })
      .finally(() => {
        shareJob.finish()
      })
  }

  return { runShareWorkflow }
}
