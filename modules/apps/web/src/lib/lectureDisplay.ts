import type { LectureIndexEntry } from '@lib/catalog/types.js'
import type { Lang } from '../i18n/ui'

/** Pick a localized string from a { lang: value } map, falling back to English then any value. */
export function pickName(map: Record<string, string> | undefined, lang: Lang): string {
  if (!map) return ''
  return map[lang] || map.en || Object.values(map)[0] || ''
}

export function lectureTitle(entry: LectureIndexEntry, lang: Lang): string {
  return pickName(entry.titles, lang) || entry.id
}

/** "Author · Location · Year", omitting any missing part. */
export function lectureMeta(entry: LectureIndexEntry, lang: Lang): string {
  const year = entry.date ? entry.date.slice(0, 4) : ''
  return [pickName(entry.authorNames, lang), pickName(entry.locationNames, lang), year]
    .filter(Boolean)
    .join(' · ')
}

/** Scripture reference chips, e.g. "BG 2.13". */
export function lectureRefs(entry: LectureIndexEntry, lang: Lang): string[] {
  return entry.refs
    .map((r) => {
      const short = r.shortNames[lang] ?? r.shortNames.en ?? Object.values(r.shortNames)[0] ?? ''
      return short ? `${short} ${r.tokens}`.trim() : r.tokens
    })
    .filter(Boolean)
}
