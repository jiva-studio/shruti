import { readonly, ref, type Ref } from "vue"

/**
 * Why the local databases are unusable, or `null` when they are fine.
 *
 * `startup.ts` swallows a user-DB failure on purpose so a bad `user.db` can't
 * brick the app. Swallowed used to mean invisible: nothing on screen said the
 * open had failed, and the router turned the silence into an onboarding loop
 * (#1724). The reason is recorded here so the storage-error screen can name it
 * and a bug report can quote it.
 *
 * Module state rather than a Pinia store: it is written during headless
 * startup, before an active Pinia exists.
 */
const failure = ref<string | null>(null)

/** Read-only view for the error screen. */
export function storageFailure(): Readonly<Ref<string | null>> {
  return readonly(failure)
}

export function recordStorageFailure(err: unknown): void {
  failure.value = err instanceof Error ? err.message : String(err)
}

/** Test-only hook — module state outlives a test file otherwise. */
export function __resetStorageFailureForTests(): void {
  failure.value = null
}
