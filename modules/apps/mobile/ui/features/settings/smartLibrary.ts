/**
 * Smart Library state rules, kept out of the dialog so they can be tested
 * without a DOM. The UI layer can't import `@shruti`, so the delay union
 * is mirrored here from `useAutoArchiveSweep`.
 */

export type AutoArchiveDelay = "off" | "immediate" | "8h" | "1d" | "2d" | "3d"

export const DEFAULT_TARGET_SECONDS = 30 * 60

export const ARCHIVE_OPTIONS = [
  "off",
  "immediate",
  "8h",
  "1d",
  "2d",
  "3d",
] as const satisfies readonly AutoArchiveDelay[]

export interface SmartLibraryState {
  targetSeconds: number
  archiveDelay: AutoArchiveDelay
}

/** i18n suffix for an archive bucket — the numeric ids need the `_` prefix. */
export function archiveOptionKey(option: AutoArchiveDelay): string {
  return /^\d/.test(option) ? `_${option}` : option
}

export function isSmartLibraryEnabled(state: SmartLibraryState): boolean {
  return state.targetSeconds > 0
}

/**
 * The master switch owns both halves. Off clears the archive delay too —
 * leaving it live behind a greyed-out list kept deleting downloaded audio
 * for a feature Settings reported as off (#1624).
 *
 * On restores both halves from what the user last picked while the feature
 * was running. `state.archiveDelay` cannot serve as that memory: off has just
 * overwritten it with `"off"`, so reading it back forgot the schedule on every
 * cycle (#1663). `lastArchiveDelay` is only ever written from an explicit pick,
 * which keeps a chosen "Never" ("off") a real answer rather than an absent one.
 */
export function smartLibraryToggled(
  checked: boolean,
  state: SmartLibraryState,
  lastTargetSeconds: number,
  lastArchiveDelay: AutoArchiveDelay
): SmartLibraryState {
  if (!checked) return { targetSeconds: 0, archiveDelay: "off" }
  return {
    targetSeconds: lastTargetSeconds > 0 ? lastTargetSeconds : DEFAULT_TARGET_SECONDS,
    archiveDelay: lastArchiveDelay,
  }
}
