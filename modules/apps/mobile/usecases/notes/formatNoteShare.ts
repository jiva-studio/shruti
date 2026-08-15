import { formatTrackDate } from "@lib/domain/services/trackDate.js"

/**
 * Renders a note for the platform share sheet / clipboard as a single
 * string with the lecture context attached. Each optional field is
 * skipped when absent so a note from an under-described track still
 * produces a sensible block — just the quote and whatever fields are
 * known.
 */
export interface NoteShareContext {
  readonly text: string
  /**
   * UI language the block is rendered for. Drives the lecture date only;
   * every other field arrives already localized from the caller.
   */
  readonly locale?: string
  /** Selection start, in **milliseconds** (matches `Note.timeStart`). */
  readonly timeStart: number
  /** Selection end, in **milliseconds**. */
  readonly timeEnd: number
  readonly track?: {
    readonly title?: string
    readonly authorName?: string
    /** ISO date string (YYYY-MM-DD). Localized via `formatTrackDate`. */
    readonly date?: string
    readonly locationName?: string
    /** Pre-formatted scripture reference (e.g. "BG 2.13"). */
    readonly reference?: string
  }
}

export function formatNoteShare(ctx: NoteShareContext): string {
  const lines: string[] = []

  lines.push(`«${ctx.text.trim()}»`)

  const t = ctx.track
  const titleAuthor = [t?.authorName, t?.title].filter(isNonEmpty).join(" — ")
  if (titleAuthor.length > 0) {
    lines.push("")
    lines.push(titleAuthor)
  }

  const date = t?.date ? formatTrackDate(t.date, ctx.locale ?? "en") : undefined
  const meta = [date, t?.locationName, t?.reference].filter(isNonEmpty).join(" · ")
  if (meta.length > 0) lines.push(meta)

  const timeRange = formatTimeRange(ctx.timeStart, ctx.timeEnd)
  if (timeRange) {
    if (meta.length === 0 && titleAuthor.length === 0) lines.push("")
    lines.push(timeRange)
  }

  return lines.join("\n")
}

function isNonEmpty(s: string | undefined): s is string {
  return typeof s === "string" && s.trim().length > 0
}

function formatTimeRange(startMs: number, endMs: number): string | null {
  if (!Number.isFinite(startMs) || startMs < 0) return null
  const start = formatMmSs(startMs)
  if (!Number.isFinite(endMs) || endMs <= startMs) return start
  return `${start}–${formatMmSs(endMs)}`
}

function formatMmSs(milliseconds: number): string {
  // Single ms → s conversion at the formatting boundary. Callers and
  // domain models keep ms end-to-end (see `Note.timeStart`).
  const total = Math.max(0, Math.floor(milliseconds / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
