function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Wall-clock date as `YYYY-MM-DD` in the device's own timezone — a rule's
 *  `ruleDate` is a local day, never a UTC one. */
export function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Wall-clock time as `HH:MM` in the device's own timezone. */
export function localTime(now: Date): string {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/** `HH:MM` from the Settings `[hour, minute]` pair. */
export function formatHourMinute(value: readonly [number, number] | undefined): string {
  if (!value) return "09:00"
  return `${pad(value[0])}:${pad(value[1])}`
}
