import type Database from "better-sqlite3"
import { connectCouch, listAllDocs, type CouchDbConfig } from "./couchdb.js"
import type { IdMap } from "./idMap.js"

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
  // Both fields are nullable in legacy docs — use `?? null` before DB insert.
  location?: string | null
  date?: [number, number, number] | null
  author?: string | null
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

/**
 * Canonical bucket paths for each track variant — derived from the
 * **new** track id, not from whatever path Couch stored. Files in
 * Wasabi still live at `library/tracks/{oldId}/...`; the migrator copies
 * them under these new keys.
 */
const audioKeyForTrack = (newTrackId: string): string =>
  `public/tracks/${newTrackId}/audio/original.mp3`
const transcriptKeyForTrack = (newTrackId: string, lang: string): string =>
  `public/tracks/${newTrackId}/transcripts/${lang}.json`

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

export interface ImportResult {
  stats: ImportStats
  /** oldCouchTrackId → new prefixed track id, for the tracks that were
   *  actually imported (filter-aware). The media migrator uses this to
   *  walk Wasabi and route each object to its new key. */
  trackIdMap: Map<string, string>
}

export interface ImportOptions {
  /** If set, only tracks whose CouchDB `author` field matches this slug
   *  (after `stripTypePrefix`, lower-cased) are imported. Dictionary
   *  rows are inserted unchanged — they're tiny and let us localise
   *  references for any author. */
  filterAuthor?: string
  /** Persistent id map. Mints stable random prefixed ids on first
   *  encounter; reuses them on every subsequent run. */
  idMap: IdMap
}

export async function importFromCouch(
  db: Database.Database,
  couchCfg: CouchDbConfig,
  opts: ImportOptions
): Promise<ImportResult> {
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
  const allTracks = trackDocs.filter((t) => t.type === "track")
  const realTracks = opts.filterAuthor
    ? allTracks.filter((t) => (t.author ?? "").toLowerCase() === opts.filterAuthor!.toLowerCase())
    : allTracks
  if (opts.filterAuthor) {
    console.log(
      `[import] filterAuthor=${opts.filterAuthor}: keeping ${realTracks.length}/${allTracks.length} tracks`
    )
  }

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

  // Prepared statements — flat dict tables have (id, language) composite PK,
  // no stub parent to populate first.
  const insAuthor = db.prepare(
    "INSERT OR REPLACE INTO authors (id, language, full_name) VALUES (?, ?, ?)"
  )
  const insLocation = db.prepare(
    "INSERT OR REPLACE INTO locations (id, language, full_name) VALUES (?, ?, ?)"
  )
  const insSource = db.prepare(
    "INSERT OR REPLACE INTO sources (id, language, full_name, short_name) VALUES (?, ?, ?, ?)"
  )
  const insLanguage = db.prepare(
    "INSERT OR REPLACE INTO languages (code, full_name, icon) VALUES (?, ?, ?)"
  )
  const insTag = db.prepare(
    "INSERT OR REPLACE INTO tags (id, language, full_name) VALUES (?, ?, ?)"
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
    "INSERT OR REPLACE INTO track_references (track_id, ref_idx, source_id, tokens) VALUES (?, ?, ?, ?)"
  )
  const insTrackTag = db.prepare(
    "INSERT OR REPLACE INTO track_tags (track_id, tag_id) VALUES (?, ?)"
  )

  // Persistent id map (loaded from disk) — built up while inserting
  // dictionaries so we can rewire FKs when inserting tracks. Keys are
  // the *stripped* couch slug (e.g. "acbsp"), not the raw
  // `author::acbsp`. `getOrCreate` mints a fresh prefixed nanoid on
  // first encounter and reuses it for every subsequent run.
  const idMap = opts.idMap
  // Tracks that we actually inserted — returned to the caller for the
  // media-migration step. oldCouchTrackId → newTrackId.
  const importedTrackIds = new Map<string, string>()

  const tx = db.transaction(() => {
    // Authors
    for (const a of authors) {
      const oldId = stripTypePrefix(a._id)
      const id = idMap.getOrCreate("authors", oldId)
      for (const [lang, name] of Object.entries(a.fullName ?? {})) {
        insAuthor.run(id, lang, name)
      }
      stats.authors += 1
    }

    // Locations
    for (const l of locations) {
      const oldId = stripTypePrefix(l._id)
      const id = idMap.getOrCreate("locations", oldId)
      for (const [lang, name] of Object.entries(l.fullName ?? {})) {
        insLocation.run(id, lang, name)
      }
      stats.locations += 1
    }

    // Sources
    for (const s of sources) {
      const oldId = stripTypePrefix(s._id)
      const id = idMap.getOrCreate("sources", oldId)
      const fullNames = s.fullName ?? {}
      const shortNames = s.shortName ?? {}
      const langs = new Set([...Object.keys(fullNames), ...Object.keys(shortNames)])
      for (const lang of langs) {
        insSource.run(id, lang, fullNames[lang] ?? "", shortNames[lang] ?? "")
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
      const oldId = stripTypePrefix(t._id)
      const id = idMap.getOrCreate("tags", oldId)
      for (const [lang, name] of Object.entries(t.fullName ?? {})) {
        insTag.run(id, lang, name)
      }
      stats.tags += 1
    }

    // Tracks
    for (const track of realTracks) {
      const trackId = idMap.getOrCreate("tracks", track._id)
      importedTrackIds.set(track._id, trackId)
      const oldAuthorId = track.author ?? null
      const oldLocationId = track.location ?? null
      const authorId = oldAuthorId ? idMap.get("authors", oldAuthorId) ?? null : null
      const locationId = oldLocationId ? idMap.get("locations", oldLocationId) ?? null : null
      if (oldAuthorId && !authorId) {
        console.warn(
          `[import] track ${track._id} references unknown author '${oldAuthorId}' — storing as NULL`
        )
      }
      if (oldLocationId && !locationId) {
        console.warn(
          `[import] track ${track._id} references unknown location '${oldLocationId}' — storing as NULL`
        )
      }

      const sortRef = track.sort_reference ?? computeSortReference(track.references)
      const sortDate = track.sort_date ?? computeSortDate(track.date)
      insTrack.run(
        trackId,
        authorId,
        locationId,
        toIsoDate(track.date),
        track.hidden ? 1 : 0,
        sortRef,
        sortDate
      )
      stats.tracks += 1

      // References — one row per group. source_id stays separate so
      // the UI can localise via sources; the numeric tokens are
      // dot-joined ("10.5", "10.5.12") for trivial split-on-read.
      if (track.references) {
        track.references.forEach((refGroup, refIdx) => {
          if (refGroup.length === 0) return
          const [sourceRaw, ...nums] = refGroup.map(String)
          const oldSourceId = sourceRaw.toLowerCase()
          const sourceId = idMap.get("sources", oldSourceId)
          if (!sourceId) {
            console.warn(
              `[import] track ${track._id} refers to unknown source '${oldSourceId}' ` +
                `(refs=${JSON.stringify(refGroup)}) — skipping reference.`
            )
            return
          }
          const tokens = nums.join(".")
          insReference.run(trackId, refIdx, sourceId, tokens)
          stats.references += 1
        })
      }

      // Tags
      for (const rawTagId of track.tags ?? []) {
        const oldTagId = stripTypePrefix(rawTagId)
        const tagId = idMap.get("tags", oldTagId)
        if (!tagId) {
          console.warn(
            `[import] track ${track._id} references unknown tag '${oldTagId}' — skipping.`
          )
          continue
        }
        insTrackTag.run(trackId, tagId)
        stats.trackTags += 1
      }

      // Variants: union of languages from title, transcripts, and languages[]
      const languageKeys = new Set<string>()
      for (const k of Object.keys(track.title ?? {})) languageKeys.add(k)
      for (const k of Object.keys(track.transcripts ?? {})) languageKeys.add(k)
      for (const lang of track.languages ?? []) languageKeys.add(lang.language)

      const audioOriginal = track.audio?.original
      // Canonical key derived from the new track id. Wasabi still
      // serves the file under `library/tracks/{oldId}/audio/...`; the
      // media migrator copies it to this key.
      const audioOriginalPath = audioOriginal ? audioKeyForTrack(trackId) : null

      for (const lang of languageKeys) {
        const title =
          track.title?.[lang] ??
          // Fallback: take any available title, else the track id
          Object.values(track.title ?? {})[0] ??
          trackId

        const langMeta = (track.languages ?? []).filter((l) => l.language === lang)
        const audioMeta = langMeta.find((l) => l.source === "track")
        const transcriptMeta = langMeta.find((l) => l.source === "transcript")
        // If Couch knows about a transcript for this lang (either via
        // `transcripts[lang]` or via languages[].source === "transcript"),
        // emit the canonical new-id path. The migrator fills the actual
        // file in.
        const hasTranscript =
          Boolean(track.transcripts?.[lang]) || Boolean(transcriptMeta)
        const transcriptPath = hasTranscript ? transcriptKeyForTrack(trackId, lang) : null

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

  // Populate the unified FTS index after the main load. Reference rows
  // are emitted in all language variants (raw id + short + full) so
  // "Бхагавад 10.5" and "BG 10.5" both match the same tracks.
  console.log("[import] populating tracks_search…")
  db.exec(`
    INSERT INTO tracks_search(content, track_id, kind)
      SELECT title, track_id, 'title' FROM track_variants;

    INSERT INTO tracks_search(content, track_id, kind)
        SELECT r.source_id || ' ' || r.tokens, r.track_id, 'reference'
        FROM track_references r
      UNION ALL
        SELECT s.short_name || ' ' || r.tokens, r.track_id, 'reference'
        FROM track_references r JOIN sources s ON s.id = r.source_id
        WHERE s.short_name <> ''
      UNION ALL
        SELECT s.full_name || ' ' || r.tokens, r.track_id, 'reference'
        FROM track_references r JOIN sources s ON s.id = r.source_id
        WHERE s.full_name <> '';
  `)

  // Sanity-check: every FK on tracks/track_references/track_tags must
  // resolve against the dictionary tables we just rewrote. Anything
  // dangling here means the id remap dropped a reference and the row
  // would render with a missing label in the app.
  console.log("[import] verifying foreign keys against new ids…")
  const orphans = {
    tracksAuthor: (db
      .prepare(
        `SELECT COUNT(*) AS n FROM tracks t
         WHERE t.author_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM authors a WHERE a.id = t.author_id)`
      )
      .get() as { n: number }).n,
    tracksLocation: (db
      .prepare(
        `SELECT COUNT(*) AS n FROM tracks t
         WHERE t.location_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM locations l WHERE l.id = t.location_id)`
      )
      .get() as { n: number }).n,
    refsSource: (db
      .prepare(
        `SELECT COUNT(*) AS n FROM track_references r
         WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id)`
      )
      .get() as { n: number }).n,
    trackTagsTag: (db
      .prepare(
        `SELECT COUNT(*) AS n FROM track_tags tt
         WHERE NOT EXISTS (SELECT 1 FROM tags g WHERE g.id = tt.tag_id)`
      )
      .get() as { n: number }).n,
    variantsTrack: (db
      .prepare(
        `SELECT COUNT(*) AS n FROM track_variants v
         WHERE NOT EXISTS (SELECT 1 FROM tracks t WHERE t.id = v.track_id)`
      )
      .get() as { n: number }).n,
  }

  const orphanTotal =
    orphans.tracksAuthor +
    orphans.tracksLocation +
    orphans.refsSource +
    orphans.trackTagsTag +
    orphans.variantsTrack
  console.log(
    `[import] id-remap check: ` +
      `tracks.author_id orphans=${orphans.tracksAuthor}, ` +
      `tracks.location_id orphans=${orphans.tracksLocation}, ` +
      `track_references.source_id orphans=${orphans.refsSource}, ` +
      `track_tags.tag_id orphans=${orphans.trackTagsTag}, ` +
      `track_variants.track_id orphans=${orphans.variantsTrack}`
  )
  if (orphanTotal > 0) {
    throw new Error(
      `[import] id remap left ${orphanTotal} dangling reference(s). ` +
        `Aborting build — the dictionaries on Couch are inconsistent with the tracks.`
    )
  }

  // Persist the id map AFTER the FK check so we never save a partially
  // valid mapping. Subsequent runs reuse these ids verbatim, which is
  // what makes media migration idempotent (same key in destination →
  // skipped).
  idMap.save()

  return { stats, trackIdMap: importedTrackIds }
}
