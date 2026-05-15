import { loadingController } from "@ionic/vue"

/**
 * Long-lived spinner with explicit lifecycle. Mirror of `useToast()` but
 * for operations that can take several seconds and whose duration we
 * can't predict up front — share-audio cut on a cold YC function being
 * the canonical example.
 *
 * `withLoading` is the only entry point — it owns the present/dismiss
 * pair via try/finally so the spinner can't outlive the work (or get
 * orphaned if the work throws).
 */
export function useLoading() {
  return {
    async withLoading<T>(message: string, fn: () => Promise<T>): Promise<T> {
      const loading = await loadingController.create({
        message,
        spinner: "crescent",
      })
      await loading.present()
      try {
        return await fn()
      } finally {
        await loading.dismiss()
      }
    },
  }
}
