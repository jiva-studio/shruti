/**
 * Stable 32-bit hash of a string id for use as a Capacitor
 * notification id. djb2 — same on every platform/version, so
 * `cancel(id)` and `schedule(id)` line up across app restarts and
 * across modules that need to compute the id for the same chat
 * message.
 *
 * Mask the sign bit instead of `Math.abs(h)` — Math.abs(INT32_MIN)
 * is INT32_MIN (the int32 range is asymmetric), which Capacitor
 * would reject as a non-positive notification id.
 */
export function notificationIdFor(chatMessageId: string): number {
  let h = 5381
  for (let i = 0; i < chatMessageId.length; i++) {
    h = ((h << 5) + h + chatMessageId.charCodeAt(i)) | 0
  }
  return (h & 0x7fffffff) || 1
}
