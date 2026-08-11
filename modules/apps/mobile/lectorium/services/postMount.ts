import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useLibraryLandingStore } from "@lectorium/stores/useLibraryLandingStore.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"

let started = false

/**
 * The work that has to happen once the app is on screen, whatever else went
 * wrong on the way there.
 *
 * `useAuthStore().restore()` is what calls `auth.initialize()` — the anonymous
 * bootstrap. Without it the run has no session and no access token at all, so
 * chat, sync, ingest and discovery every one of them 401. It used to live at the
 * tail of `start()`, which meant any rejection earlier in startup silently cost
 * the whole run its identity (#1738). It lives here so the last-resort handler
 * in `main.ts` can run it too.
 *
 * Idempotent: `start()` and its `.catch()` may both reach it.
 */
export function runPostMountWork(): void {
  if (started) return
  started = true

  void usePurchasesStore()
    .init()
    .catch((e) => reportError("purchases", e))
  void useAuthStore()
    .restore()
    .catch((e) => reportError("auth", e))
  void useLibraryLandingStore()
    .ensureLoaded()
    .catch((e) => console.warn("library landing preload failed", e))
}

/** Test-only hook — the once-flag is module state. */
export function __resetPostMountForTests(): void {
  started = false
}
