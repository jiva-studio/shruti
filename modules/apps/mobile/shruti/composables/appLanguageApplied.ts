/**
 * Did startup already put the user's stored UI language on screen?
 *
 * Written by `applyStoredAppLanguage` (which `main.ts` runs before mount) and
 * read by `useLocaleSync` to decide whether its immediate run has anything left
 * to do. Its own module so `useLocaleSync` — a leaf composable — does not have
 * to import `useAppLanguage`, which reaches the composition root through
 * `useConfig` and already sits in an import cycle with it.
 *
 * Module state rather than a store: it is written during headless startup,
 * before an active Pinia exists.
 */
let applied = false

export function storedAppLanguageApplied(): boolean {
  return applied
}

export function markStoredAppLanguageApplied(): void {
  applied = true
}

/** Test-only hook — module state outlives a test file otherwise. */
export function __resetStoredAppLanguageForTests(): void {
  applied = false
}
