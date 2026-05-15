import { loadingController } from "@ionic/vue"

/**
 * Long-lived spinner with explicit lifecycle. Mirror of `useToast()` but
 * for operations that can take several seconds and whose duration we
 * can't predict up front — share-audio cut on a cold YC function being
 * the canonical example, share-video reel rendering taking the same
 * shape but ~2 minutes.
 *
 * `withLoading` is the only entry point — it owns the present/dismiss
 * pair via try/finally so the spinner can't outlive the work (or get
 * orphaned if the work throws).
 *
 * The work function receives a `ctx` with `setLabel(next)` so long-running
 * flows (share-video) can refresh the spinner label as their phase
 * progresses. Ionic's `loadingController` exposes `.message` as a mutable
 * field — assigning to it updates the visible text without re-presenting.
 * Callers that don't need progressive labels just ignore the param.
 */
export interface LoadingControl {
  setLabel(next: string): void
}

export function useLoading() {
  return {
    async withLoading<T>(message: string, fn: (ctx: LoadingControl) => Promise<T>): Promise<T> {
      const loading = await loadingController.create({
        message,
        spinner: "crescent",
      })
      await loading.present()
      const ctx: LoadingControl = {
        setLabel(next: string) {
          loading.message = next
        },
      }
      try {
        return await fn(ctx)
      } finally {
        await loading.dismiss()
      }
    },
  }
}
