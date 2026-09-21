export interface Chapter {
  title: string
  startMs: number
  endMs: number
}

export interface Separator {
  title: string
  startMs: number
  active: boolean
}

/**
 * Waveform bar index → the chapter separator drawn on it. A chapter landing on
 * the first bar is dropped, so a separator never hides the opening peak; the
 * chapter the playhead is inside is the active one.
 */
export function buildChapterSeparators(
  barCount: number,
  chapters: readonly Chapter[] | undefined,
  durationMs: number,
  positionMs: number
): Map<number, Separator> {
  const map = new Map<number, Separator>()
  if (!chapters || chapters.length === 0 || barCount <= 1 || durationMs <= 0) return map

  let activeIdx = -1
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startMs <= positionMs) activeIdx = i
    else break
  }

  for (let i = 0; i < chapters.length; i++) {
    let f = chapters[i].startMs / durationMs
    if (f < 0) f = 0
    if (f > 1) f = 1
    const barIdx = Math.round(f * (barCount - 1))
    if (barIdx <= 0) continue
    map.set(barIdx, {
      title: chapters[i].title,
      startMs: chapters[i].startMs,
      active: i === activeIdx,
    })
  }
  return map
}
