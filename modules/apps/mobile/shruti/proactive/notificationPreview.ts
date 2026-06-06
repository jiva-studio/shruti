/**
 * Turn a proactive message's markdown body into a single short line
 * suitable for an OS push notification body.
 *
 * Proactive bodies carry marker grammar the chat renderer understands
 * but a notification can't: `[action:kind|id=…]`, `[^N]` card markers,
 * `[cite:track@start-end|caption]`, and the occasional leaked `[s=…]`
 * sentence marker. Those get stripped, light markdown punctuation is
 * dropped, whitespace is collapsed, and the result is truncated with an
 * ellipsis so the notification stays one tidy line.
 *
 * Returns an empty string when there's nothing left after stripping —
 * the caller uses that as the signal to NOT schedule a contentless
 * notification (and to leave any previously-scheduled one in place).
 */
const MARKER_PATTERNS: readonly RegExp[] = [
  /\[action:[a-z][a-z0-9_]*\|[^\]]*\]/gi, // [action:queue_next_track|id=main]
  /\[cite:[^\]]*\]/gi, // [cite:track_x@0-12|caption]
  /\[\^[^\]]*\]/g, // [^1] footnote / card marker
  /\[s=[^\]]*\]/g, // [s=0,1] leaked sentence marker
]

export function toNotificationPreview(bodyMd: string, max = 120): string {
  let text = bodyMd
  for (const re of MARKER_PATTERNS) text = text.replace(re, " ")
  const cleaned = text
    // Drop the markdown punctuation that reads as noise inline: heading
    // hashes, emphasis, inline-code ticks, blockquote markers, list
    // bullets at line starts.
    .replace(/^\s*[#>\-*]+\s*/gm, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (cleaned.length <= max) return cleaned
  return cleaned.slice(0, max - 1).trimEnd() + "…"
}
