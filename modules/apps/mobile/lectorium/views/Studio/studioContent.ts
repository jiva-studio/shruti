import type { NoteMeta } from "@lib/domain/note.js"
import type { TranscriptBlock, TranscriptSentenceBlock } from "@lib/domain/transcript.js"
import type { StudioVideoSubject } from "@lectorium/services/shareArtifactKeys.js"

export interface StudioEdit {
  text?: string
  title?: string
}

export interface CitationContext {
  trackId: string
  startMs: number
  endMs: number
  caption?: string
}

export interface ShareRange {
  readonly subject: StudioVideoSubject
  readonly startMs: number
  readonly endMs: number
}

/** The edit a previous Studio session saved on the note, if any. */
export function readStudioMeta(meta: NoteMeta | null | undefined): StudioEdit | null {
  if (!meta || typeof meta !== "object") return null
  const studio = (meta as Record<string, unknown>).studio
  if (!studio || typeof studio !== "object") return null
  return studio as StudioEdit
}

/** The note meta carrying `text`/`title`, or null when neither has changed. */
export function nextStudioMeta(
  meta: NoteMeta | null | undefined,
  text: string,
  title: string
): NoteMeta | null {
  const existing = readStudioMeta(meta)
  if ((existing?.text ?? null) === text && (existing?.title ?? "") === title) return null
  const studio: StudioEdit = { ...(existing ?? {}), text }
  if (title.length > 0) studio.title = title
  else delete studio.title
  return { ...((meta ?? {}) as NoteMeta), studio }
}

/**
 * What the video is cut from. A citation wins: the page is cached by
 * IonRouterOutlet and the mode refs are reset on every entry, so whichever is
 * set is the one this entry loaded.
 */
export function studioShareRange(
  note: { id: string; timeStart: number; timeEnd: number } | null,
  citation: CitationContext | null
): ShareRange | null {
  if (citation) {
    const { trackId, startMs, endMs } = citation
    return { subject: { kind: "citation", trackId, startMs, endMs }, startMs, endMs }
  }
  if (note) {
    return {
      subject: { kind: "note", noteId: note.id },
      startMs: note.timeStart,
      endMs: note.timeEnd,
    }
  }
  return null
}

/** The transcript sentences overlapping a window, joined as one quote. */
export function joinOverlappingSentences(
  blocks: readonly TranscriptBlock[],
  startMs: number,
  endMs: number
): string {
  return blocks
    .filter((b): b is TranscriptSentenceBlock => b.type === "sentence")
    .filter((b) => b.end >= startMs && b.start <= endMs)
    .map((b) => b.text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
}
