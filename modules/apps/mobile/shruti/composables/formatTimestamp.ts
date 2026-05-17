/**
 * Format a millisecond duration as a colon-separated timestamp.
 *
 * - `MM:SS` if under one hour
 * - `HH:MM:SS` once we pass an hour
 *
 * Always zero-pads M and S so columns of timestamps line up under
 * `font-variant-numeric: tabular-nums`. H is NOT zero-padded — a single
 * leading digit is more readable for lectures that exceed an hour.
 *
 * Returns "00:00" for negative or non-finite input rather than throwing
 * — the call sites are mostly in templates where a runtime error would
 * blank the whole bubble.
 */
export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00"
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
