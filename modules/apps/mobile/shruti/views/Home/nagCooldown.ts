/** A dismissed nag comes back after the cooldown; one never dismissed is due now. */
export function isNagDue(dismissedAt: number | null, now: number, cooldownMs: number): boolean {
  if (dismissedAt === null) return true
  return now - dismissedAt >= cooldownMs
}

/** Asking before the user has had the app for `graceMs` is the wrong first
 *  impression; an unknown install date stays quiet. */
export function isPastGrace(installedAt: number | null, now: number, graceMs: number): boolean {
  if (installedAt === null) return false
  return now - installedAt >= graceMs
}
