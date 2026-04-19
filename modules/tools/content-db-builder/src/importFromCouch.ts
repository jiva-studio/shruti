import type Database from "better-sqlite3"
import { connectCouch, listAllDocs, type CouchDbConfig } from "./couchdb.js"

/* ---------- CouchDB document shapes ---------------------------------------- */

interface CouchAuthor {
  _id: string
  type: "author"
  fullName?: Record<string, string>
}

interface CouchLocation {
  _id: string
  type: "location"
  fullName?: Record<string, string>
}

interface CouchSource {
  _id: string
  type: "source"
  fullName?: Record<string, string>
  shortName?: Record<string, string>
}

interface CouchLanguage {
  _id: string
  type: "language"
  code: string
  fullName: string
  icon?: string
}

interface CouchTag {
  _id: string
  type: "tag"
  fullName?: Record<string, string>
}

interface CouchDictionaryDoc {
  _id: string
  type: string
  [key: string]: unknown
}

interface CouchTrackAudioVariant {
  path: string
  fileSize?: number
  duration?: number
}

interface CouchTrackLanguage {
  language: string
  source: "track" | "transcript"
  type: "original" | "generated" | "edited"
}

interface CouchTrack {
  _id: string
  type: "track"
  location: string
  date: [number, number, number] | null
  author: string
  title: Record<string, string>
  references?: Array<Array<string | number>>
  audio?: {
    original?: CouchTrackAudioVariant
    clean?: CouchTrackAudioVariant
  }
  languages?: CouchTrackLanguage[]
  transcripts?: Record<string, { path: string }>
  tags?: string[]
  hidden?: boolean
  sort_reference?: string
  sort_date?: string
}

/* ---------- helpers -------------------------------------------------------- */

function stripTypePrefix(id: string): string {
  const colonIdx = id.indexOf("::")
  return colonIdx >= 0 ? id.substring(colonIdx + 2) : id
}

function toIsoDate(date: [number, number, number] | null | undefined): string | null {
  if (!date || date.length !== 3) return null
  const [y, m, d] = date
  if (!y) return null
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`
}

function computeSortDate(date: [number, number, number] | null | undefined): string {
  if (!date || date.length !== 3) return "00000000"
  const [y = 0, m = 0, d = 0] = date
  return `${String(y).padStart(4, "0")}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`
}

function computeSortReference(references: Array<Array<string | number>> | undefined): string {
  if (!references || references.length === 0) return "zzzzzz"
  // Lexicographically sortable: join tokens with _, zero-pad numeric tokens
  const first = references[0]
  return first
    .map((tok) => (typeof tok === "number" ? String(tok).padStart(6, "0") : String(tok)))
    .join("_")
}

function prefixBucketPath(path: string | undefined): string | null {
  if (!path) return null
  if (path.startsWith("public/")) return path
  // Some legacy CouchDB paths don't include the "public/" prefix.
  return `public/${path.replace(/^\/+/, "")}`
}

/* ---------- main import ---------------------------------------------------- */

export interface ImportStats {
  authors: number
  locations: number
  sources: number
  languages: number
  tags: number
  tracks: number
  variants: number
  references: number
  trackTags: number
}

export async function importFromCouch(
  db: Database.Database,
  couchCfg: CouchDbConfig
): Promise<ImportStats> {
  const cx = connectCouch(couchCfg)
  const dictionary = cx.use<CouchDictionaryDoc>("dictionary")
  const tracks = cx.use<CouchTrack>("tracks")

  console.log("[import] reading dictionary…")
  const dictDocs = await listAllDocs<CouchDictionaryDoc>(dictionary)

  const authors = dictDocs.filter((d) => d.type === "author") as unknown as CouchAuthor[]
  const locations = dictDocs.filter((d) => d.type === "location") as unknown as CouchLocation[]
  const sources = dictDocs.filter((d) => d.type === "source") as unknown as CouchSource[]
  const langs = dictDocs.filter((d) => d.type === "language") as unknown as CouchLanguage[]
  const tags = dictDocs.filter((d) => d.type === "tag") as unknown as CouchTag[]
  // durations and sort methods are intentionally skipped — UI constants

  console.log("[import] reading tracks…")
  const trackDocs = await listAllDocs<CouchTrack>(tracks)
  const realTracks = trackDocs.filter((t) => t.type === "track")

  const stats: ImportStats = {
    authors: 0,
    locations: 0,
    sources: 0,
    languages: 0,
    tags: 0,
    tracks: 0,
    variants: 0,
    references: 0,
    trackTags: 0,
  }

  // Prepared statements
  const insAuthor = db.prepare("INSERT OR REPLACE INTO authors (id) VALUES (?)")
  const insAuthorName = db.prepare(
    "INSERT OR REPLACE INTO author_names (author_id, language, full_name) VALUES (?, ?, ?)"
  )
  const insLocation = db.prepare("INSERT OR REPLACE INTO locations (id) VALUES (?)")
  const insLocationName = db.prepare(
    "INSERT OR REPLACE INTO location_names (location_id, language, full_name) VALUES (?, ?, ?)"
  )
  const insSource = db.prepare("INSERT OR REPLACE INTO sources (id) VALUES (?)")
  const insSourceName = db.prepare(
    "INSERT OR REPLACE INTO source_names (source_id, language, full_name, short_name) VALUES (?, ?, ?, ?)"
  )
  const insLanguage = db.prepare(
    "INSERT OR REPLACE INTO languages (code, full_name, icon) VALUES (?, ?, ?)"
  )
  const insTag = db.prepare("INSERT OR REPLACE INTO tags (id) VALUES (?)")
  const insTagName = db.prepare(
    "INSERT OR REPLACE INTO tag_names (tag_id, language, full_name) VALUES (?, ?, ?)"
  )
  const insTrack = db.prepare(
    `INSERT OR REPLACE INTO tracks
      (id, author_id, location_id, date, hidden, sort_reference, sort_date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const insVariant = db.prepare(
    `INSERT OR REPLACE INTO track_variants
      (track_id, language, title, audio_path, audio_filesize, audio_duration,
       audio_kind, transcript_path, transcript_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insReference = db.prepare(
    "INSERT OR REPLACE INTO track_references (track_id, ord, token) VALUES (?, ?, ?)"
  )
  const insTrackTag = db.prepare(
    "INSERT OR REPLACE INTO track_tags (track_id, tag_id) VALUES (?, ?)"
  )

  const tx = db.transaction(() => {
    // Authors
    for (const a of authors) {
      const id = stripTypePrefix(a._id)
      insAuthor.run(id)
      for (const [lang, name] of Object.entries(a.fullName ?? {})) {
        insAuthorName.run(id, lang, name)
      }
      stats.authors += 1
    }

    // Locations
    for (const l of locations) {
      const id = stripTypePrefix(l._id)
      insLocation.run(id)
      for (const [lang, name] of Object.entries(l.fullName ?? {})) {
        insLocationName.run(id, lang, name)
      }
      stats.locations += 1
    }

    // Sources
    for (const s of sources) {
      const id = stripTypePrefix(s._id)
      insSource.run(id)
      const fullNames = s.fullName ?? {}
      const shortNames = s.shortName ?? {}
      const langs = new Set([...Object.keys(fullNames), ...Object.keys(shortNames)])
      for (const lang of langs) {
        insSourceName.run(id, lang, fullNames[lang] ?? "", shortNames[lang] ?? "")
      }
      stats.sources += 1
    }

    // Languages
    for (const l of langs) {
      insLanguage.run(l.code, l.fullName, l.icon ?? null)
      stats.languages += 1
    }

    // Tags
    for (const t of tags) {
      const id = stripTypePrefix(t._id)
      insTag.run(id)
      for (const [lang, name] of Object.entries(t.fullName ?? {})) {
        insTagName.run(id, lang, name)
      }
      stats.tags += 1
    }

    // Tracks
    for (const track of realTracks) {
      const trackId = track._id
      const sortRef = track.sort_reference ?? computeSortReference(track.references)
      const sortDate = track.sort_date ?? computeSortDate(track.date)
      insTrack.run(
        trackId,
        track.author,
        track.location,
        toIsoDate(track.date),
        track.hidden ? 1 : 0,
        sortRef,
        sortDate
      )
      stats.tracks += 1

      // References
      if (track.references) {
        let ord = 0
        for (const refGroup of track.references) {
          for (const tok of refGroup) {
            insReference.run(trackId, ord, String(tok))
            ord += 1
            stats.references += 1
          }
        }
      }

      // Tags
      for (const tagId of track.tags ?? []) {
        insTrackTag.run(trackId, stripTypePrefix(tagId))
        stats.trackTags += 1
      }

      // Variants: union of languages from title, transcripts, and languages[]
      const languageKeys = new Set<string>()
      for (const k of Object.keys(track.title ?? {})) languageKeys.add(k)
      for (const k of Object.keys(track.transcripts ?? {})) languageKeys.add(k)
      for (const lang of track.languages ?? []) languageKeys.add(lang.language)

      const audioOriginal = track.audio?.original
      const audioOriginalPath = prefixBucketPath(audioOriginal?.path)

      for (const lang of languageKeys) {
        const title =
          track.title?.[lang] ??
          // Fallback: take any available title, else the track id
          Object.values(track.title ?? {})[0] ??
          trackId

        const langMeta = (track.languages ?? []).filter((l) => l.language === lang)
        const audioMeta = langMeta.find((l) => l.source === "track")
        const transcriptMeta = langMeta.find((l) => l.source === "transcript")
        const transcriptPath = prefixBucketPath(track.transcripts?.[lang]?.path)

        insVariant.run(
          trackId,
          lang,
          title,
          audioMeta ? audioOriginalPath : null,
          audioMeta ? audioOriginal?.fileSize ?? null : null,
          audioMeta ? audioOriginal?.duration ?? null : null,
          audioMeta ? audioMeta.type : null,
          transcriptPath,
          transcriptPath && transcriptMeta ? transcriptMeta.type : null
        )
        stats.variants += 1
      }
    }
  })

  tx()
  return stats
}
