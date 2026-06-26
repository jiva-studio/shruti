import type { OutlineChapter, TranscriptBlock, TranscriptGroup } from './types'

export function parseOutline(raw: string | null): OutlineChapter[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: OutlineChapter[] = []
  for (const e of parsed) {
    if (e == null || typeof e !== 'object') continue
    const entry = e as Record<string, unknown>
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    const start = typeof entry.start === 'number' ? entry.start : null
    const end = typeof entry.end === 'number' ? entry.end : null
    if (!title || start === null) continue
    if (end === null || end <= start) continue
    out.push({ title, startMs: start, endMs: end })
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out
}

function blockText(block: TranscriptBlock): string {
  if (block.type === 'sentence') return block.text
  if (block.type === 'verse:translation') return block.text
  if (block.type === 'verse:text') return block.text.join(' ')
  return ''
}

interface BuildOpts {
  paragraphChars?: number
}

export function buildTranscriptGroups(
  blocks: TranscriptBlock[],
  outline: OutlineChapter[],
  opts: BuildOpts = {}
): TranscriptGroup[] {
  const paragraphChars = opts.paragraphChars ?? 220

  const chapters = outline
    .filter((c) => Number.isFinite(c.startMs))
    .slice()
    .sort((a, b) => a.startMs - b.startMs)
  let chapterIdx = 0

  const groups: TranscriptGroup[] = []
  let current: TranscriptBlock[] = []
  let charsAccum = 0
  let currentHeading: { title: string; startMs: number } | undefined
  let currentSpeaker: string | undefined

  const flush = () => {
    if (current.length > 0) {
      groups.push({
        heading: currentHeading?.title,
        headingStartMs: currentHeading?.startMs,
        startMs: current[0].start,
        endMs: current[current.length - 1].end,
        blocks: current,
      })
    }
    current = []
    charsAccum = 0
    currentHeading = undefined
    currentSpeaker = undefined
  }

  for (const block of blocks) {
    if (block.type === 'paragraph') {
      flush()
      continue
    }

    let triggered: { title: string; startMs: number } | undefined
    while (chapterIdx < chapters.length && block.start >= chapters[chapterIdx].startMs) {
      triggered = { title: chapters[chapterIdx].title, startMs: chapters[chapterIdx].startMs }
      chapterIdx++
    }
    if (triggered) {
      flush()
      currentHeading = triggered
    }

    // Start a new paragraph whenever the speaker changes, so each turn in a
    // dialogue stands on its own (with its own timestamp + highlight).
    const speaker = block.type === 'sentence' ? block.speaker : undefined
    if (speaker !== undefined && current.length > 0 && speaker !== currentSpeaker) {
      flush()
    }

    const len = blockText(block).length
    if (paragraphChars > 0 && current.length > 0 && charsAccum + len > paragraphChars) {
      flush()
    }

    current.push(block)
    charsAccum += len
    if (speaker !== undefined) currentSpeaker = speaker
  }

  flush()

  if (chapterIdx < chapters.length && groups.length > 0) {
    const last = groups[groups.length - 1]
    if (last.heading === undefined) {
      const ch = chapters[chapters.length - 1]
      last.heading = ch.title
      last.headingStartMs = ch.startMs
    }
  }

  return groups
}
