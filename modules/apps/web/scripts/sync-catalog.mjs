// Phase B (not yet built): scale full per-track generation to the whole ~5000
// corpus, add a peaks/waveform precompute pipeline, and swap static emit for an
// SSR adapter so track pages render on demand instead of being capped at build.

import { mkdirSync, existsSync, writeFileSync, readFileSync, createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import Database from 'better-sqlite3'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const cacheDir = join(webRoot, '.cache')
const transcriptCacheDir = join(cacheDir, 'transcripts')
const dataDir = join(webRoot, 'src', 'data')
// Per-lecture JSON lives under public/ so it ships as static, fetchable
// files (client SPA navigation pulls them on demand) instead of being
// bundled into thousands of Vite chunks — which OOMs the client build.
const lecturesDir = join(webRoot, 'public', 'data', 'lectures')

const S3_BASE = 'https://cdn-s3.shruti.local'
const CONFIG_URL = `${S3_BASE}/public/config.json`
const SYNC_LIMIT = Number(process.env.SYNC_LIMIT ?? 60)

for (const dir of [cacheDir, transcriptCacheDir, dataDir, lecturesDir]) {
  mkdirSync(dir, { recursive: true })
}

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.json()
}

async function downloadTo(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

function resolveUrl(path) {
  if (!path) return null
  return `${S3_BASE}/${path.replace(/^\/+/, '')}`
}

function foldDict(rows, pick) {
  const map = new Map()
  for (const r of rows) {
    let m = map.get(r.id)
    if (!m) {
      m = {}
      map.set(r.id, m)
    }
    m[r.language] = pick(r)
  }
  return map
}

function langMapFor(map, id) {
  if (id == null) return {}
  return map.get(id) ?? {}
}

// Fold a multi-language dictionary keyed by id into { id → { lang → {field: val} } }.
function foldFields(rows, fields) {
  const map = new Map()
  for (const r of rows) {
    let langs = map.get(r.id)
    if (!langs) {
      langs = {}
      map.set(r.id, langs)
    }
    const obj = {}
    for (const f of fields) obj[f] = r[f] ?? null
    langs[r.language] = obj
  }
  return map
}

function pickField(langs, field) {
  if (!langs) return {}
  const out = {}
  for (const [lang, obj] of Object.entries(langs)) {
    if (obj[field]) out[lang] = obj[field]
  }
  return out
}

// URL slug from an English-leaning name, kept unique against `seen`.
function slugify(name, idTail, seen) {
  let base = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  if (!base) base = idTail
  let slug = base
  if (seen.has(slug)) slug = `${base}-${idTail}`
  seen.add(slug)
  return slug
}

async function fetchTranscript(id, lang, transcriptPath) {
  if (!transcriptPath) return null
  const cacheFile = join(transcriptCacheDir, `${id}.${lang}.json`)
  if (existsSync(cacheFile)) {
    const cached = readFileSync(cacheFile, 'utf8')
    if (cached === 'null') return null
    try {
      return JSON.parse(cached)
    } catch {
      return null
    }
  }
  const url = resolveUrl(transcriptPath)
  let data = null
  try {
    const res = await fetch(url)
    if (res.ok) {
      data = await res.json()
    } else if (res.status !== 404) {
      console.warn(`  transcript ${id}.${lang} → ${res.status}`)
    }
  } catch (e) {
    console.warn(`  transcript ${id}.${lang} fetch failed: ${e.message}`)
  }
  writeFileSync(cacheFile, data ? JSON.stringify(data) : 'null')
  return data
}

function parseOutline(raw) {
  if (!raw) return []
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out = []
  for (const e of parsed) {
    if (e == null || typeof e !== 'object') continue
    const title = typeof e.title === 'string' ? e.title.trim() : ''
    const start = typeof e.start === 'number' ? e.start : null
    const end = typeof e.end === 'number' ? e.end : null
    if (!title || start === null) continue
    if (end === null || end <= start) continue
    out.push({ title, startMs: start, endMs: end })
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out
}

function normalizeTranscript(raw) {
  if (!raw || !Array.isArray(raw.blocks)) return null
  const blocks = []
  for (const b of raw.blocks) {
    if (b == null || typeof b !== 'object') continue
    if (typeof b.type !== 'string') continue
    if (typeof b.start !== 'number' || typeof b.end !== 'number') continue
    blocks.push(b)
  }
  return { version: typeof raw.version === 'number' ? raw.version : null, blocks }
}

async function main() {
  console.log('Fetching config…')
  const config = await fetchJson(CONFIG_URL)
  const version = Array.isArray(config.databases) && config.databases.length > 0
    ? config.databases[0].version
    : config.version
  if (version == null) throw new Error('config.json has no version')
  console.log(`Catalog version: ${version}`)

  const dbFile = join(cacheDir, `catalog.${version}.db`)
  if (existsSync(dbFile)) {
    console.log(`DB cached: ${dbFile}`)
  } else {
    const dbUrl = `${S3_BASE}/public/db/shruti.${version}.db`
    console.log(`Downloading DB ${dbUrl}…`)
    await downloadTo(dbUrl, dbFile)
    console.log(`Saved ${dbFile}`)
  }

  const db = new Database(dbFile, { readonly: true })

  const authors = foldDict(db.prepare('SELECT id, language, full_name FROM authors').all(), (r) => r.full_name)
  const locations = foldDict(db.prepare('SELECT id, language, full_name FROM locations').all(), (r) => r.full_name)
  const sourcesFull = foldDict(db.prepare('SELECT id, language, full_name, short_name FROM sources').all(), (r) => r.full_name)
  const sourcesShort = foldDict(db.prepare('SELECT id, language, full_name, short_name FROM sources').all(), (r) => r.short_name ?? r.full_name)

  // --- Topics: per-track top-N associations + reverse topic→tracks index ---
  const topicDict = foldFields(
    db.prepare('SELECT id, language, full_name, short_name, cover FROM topics').all(),
    ['full_name', 'short_name', 'cover']
  )
  const TOPICS_PER_TRACK = 8
  const topicsByTrack = new Map()
  for (const r of db.prepare('SELECT track_id, topic_id, weight FROM track_topics').all()) {
    let arr = topicsByTrack.get(r.track_id)
    if (!arr) {
      arr = []
      topicsByTrack.set(r.track_id, arr)
    }
    arr.push({ topicId: r.topic_id, weight: r.weight })
  }
  for (const arr of topicsByTrack.values()) {
    arr.sort((a, b) => b.weight - a.weight)
    arr.length = Math.min(arr.length, TOPICS_PER_TRACK)
  }
  const topicTracks = new Map() // topic_id → [{ trackId, weight }]

  // --- Collections + groups (the curated "categories") ---
  const groupDict = foldFields(
    db.prepare('SELECT id, language, name, description, sort_order FROM collection_groups').all(),
    ['name', 'description', 'sort_order']
  )
  const collectionDict = foldFields(
    db.prepare('SELECT id, language, name, description, cover, sort_order FROM collections').all(),
    ['name', 'description', 'cover', 'sort_order']
  )
  const groupItems = new Map() // group_id → [{ collectionId, position }]
  for (const r of db.prepare('SELECT group_id, collection_id, position FROM collection_group_items').all()) {
    let arr = groupItems.get(r.group_id)
    if (!arr) {
      arr = []
      groupItems.set(r.group_id, arr)
    }
    if (!arr.some((x) => x.collectionId === r.collection_id)) {
      arr.push({ collectionId: r.collection_id, position: r.position })
    }
  }
  const collectionTracks = new Map() // collection_id → [{ trackId, position }]
  for (const r of db.prepare('SELECT collection_id, track_id, position FROM collection_tracks ORDER BY position').all()) {
    let arr = collectionTracks.get(r.collection_id)
    if (!arr) {
      arr = []
      collectionTracks.set(r.collection_id, arr)
    }
    if (!arr.some((x) => x.trackId === r.track_id)) {
      arr.push({ trackId: r.track_id, position: r.position })
    }
  }

  const tracks = db
    .prepare('SELECT id, author_id, location_id, date FROM tracks WHERE hidden = 0 OR hidden IS NULL')
    .all()
    .map((t) => ({ ...t, date: t.date ? t.date : null }))

  const variantStmt = db.prepare(
    'SELECT language, title, transcript_path, outline, description FROM track_variants WHERE track_id = ?'
  )
  const audioStmt = db.prepare('SELECT language, kind, path, duration FROM track_audio WHERE track_id = ?')
  const refStmt = db.prepare('SELECT source_id, tokens FROM track_references WHERE track_id = ? ORDER BY ref_idx')

  const index = []
  const fullCandidates = []

  for (const t of tracks) {
    const variants = variantStmt.all(t.id)
    const audios = audioStmt.all(t.id)
    const refRows = refStmt.all(t.id)

    const titles = {}
    const contentLanguages = []
    let hasTranscript = false
    let hasOutline = false
    for (const v of variants) {
      if (v.title) titles[v.language] = v.title
      if (!contentLanguages.includes(v.language)) contentLanguages.push(v.language)
      if (v.transcript_path) hasTranscript = true
      if (parseOutline(v.outline).length > 0) hasOutline = true
    }

    let durationMs = null
    for (const a of audios) {
      if (typeof a.duration === 'number') {
        durationMs = a.duration
        break
      }
    }

    const refs = refRows.map((r) => ({
      sourceId: r.source_id,
      shortNames: langMapFor(sourcesShort, r.source_id),
      tokens: r.tokens,
    }))

    const trackTopics = topicsByTrack.get(t.id) ?? []
    const topicIds = trackTopics.map((x) => x.topicId)
    for (const { topicId, weight } of trackTopics) {
      let arr = topicTracks.get(topicId)
      if (!arr) {
        arr = []
        topicTracks.set(topicId, arr)
      }
      arr.push({ trackId: t.id, weight })
    }

    const entry = {
      id: t.id,
      slug: t.id,
      date: t.date ?? null,
      durationMs,
      contentLanguages,
      authorId: t.author_id ?? null,
      authorNames: langMapFor(authors, t.author_id),
      locationId: t.location_id ?? null,
      locationNames: langMapFor(locations, t.location_id),
      titles,
      refs,
      topicIds,
      hasTranscript,
      hasOutline,
    }
    index.push(entry)

    if (hasTranscript) {
      fullCandidates.push({ track: t, variants, audios, refs, topicIds, hasOutline })
    }
  }

  writeFileSync(join(dataDir, 'lectures-index.json'), JSON.stringify(index))

  // --- topics-index.json: one entry per topic that has lectures ---
  const topicSlugs = new Set()
  const topicsIndex = []
  for (const [topicId, langs] of topicDict) {
    const trackArr = (topicTracks.get(topicId) ?? []).slice().sort((a, b) => b.weight - a.weight)
    if (trackArr.length === 0) continue
    const names = pickField(langs, 'full_name')
    const shortNames = pickField(langs, 'short_name')
    const cover = resolveUrl(langs.en?.cover ?? Object.values(langs)[0]?.cover ?? null)
    topicsIndex.push({
      id: topicId,
      slug: slugify(names.en || Object.values(names)[0] || topicId, topicId.slice(-6), topicSlugs),
      names,
      shortNames,
      cover,
      count: trackArr.length,
      trackIds: trackArr.map((x) => x.trackId),
    })
  }
  topicsIndex.sort((a, b) => b.count - a.count)
  writeFileSync(join(dataDir, 'topics-index.json'), JSON.stringify(topicsIndex))

  // --- collections-index.json: curated groups → collections → lectures ---
  const collectionSlugs = new Set()
  const collectionsById = {}
  for (const [collId, langs] of collectionDict) {
    const trackArr = collectionTracks.get(collId) ?? []
    if (trackArr.length === 0) continue
    const names = pickField(langs, 'name')
    collectionsById[collId] = {
      id: collId,
      slug: slugify(names.en || Object.values(names)[0] || collId, collId.slice(-6), collectionSlugs),
      names,
      descriptions: pickField(langs, 'description'),
      cover: resolveUrl(langs.en?.cover ?? Object.values(langs)[0]?.cover ?? null),
      count: trackArr.length,
      trackIds: trackArr.map((x) => x.trackId),
    }
  }
  const collectionGroups = []
  const sortOrderOf = (langs) => Number(langs.en?.sort_order ?? Object.values(langs)[0]?.sort_order ?? 0)
  const groupIds = [...groupDict.keys()].sort((a, b) => sortOrderOf(groupDict.get(a)) - sortOrderOf(groupDict.get(b)))
  for (const groupId of groupIds) {
    const langs = groupDict.get(groupId)
    const items = (groupItems.get(groupId) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((x) => collectionsById[x.collectionId])
      .filter(Boolean)
    if (items.length === 0) continue
    collectionGroups.push({
      id: groupId,
      names: pickField(langs, 'name'),
      descriptions: pickField(langs, 'description'),
      collectionIds: items.map((c) => c.id),
    })
  }
  writeFileSync(
    join(dataDir, 'collections-index.json'),
    JSON.stringify({ groups: collectionGroups, collections: collectionsById })
  )

  fullCandidates.sort((a, b) => {
    const ao = a.hasOutline ? 0 : 1
    const bo = b.hasOutline ? 0 : 1
    if (ao !== bo) return ao - bo
    return String(a.track.date ?? '').localeCompare(String(b.track.date ?? ''))
  })

  const build = fullCandidates.slice(0, SYNC_LIMIT)
  let fullCount = 0

  for (const c of build) {
    const { track, variants, audios, refs } = c
    const audioByLang = new Map()
    for (const a of audios) {
      const cur = audioByLang.get(a.language)
      if (!cur || (cur.kind !== 'clean' && a.kind === 'clean')) {
        audioByLang.set(a.language, a)
      }
    }

    const outVariants = {}
    for (const v of variants) {
      const outline = parseOutline(v.outline)
      const audioRow = audioByLang.get(v.language) ?? null
      const audio = audioRow
        ? { url: resolveUrl(audioRow.path), durationMs: typeof audioRow.duration === 'number' ? audioRow.duration : null }
        : null
      const transcript = normalizeTranscript(await fetchTranscript(track.id, v.language, v.transcript_path))
      outVariants[v.language] = {
        title: v.title ?? '',
        description: v.description ?? null,
        outline,
        audio,
        transcript,
      }
    }

    const record = {
      id: track.id,
      slug: track.id,
      date: track.date ?? null,
      authorId: track.author_id ?? null,
      authorNames: langMapFor(authors, track.author_id),
      locationId: track.location_id ?? null,
      locationNames: langMapFor(locations, track.location_id),
      variants: outVariants,
      refs,
      topicIds: c.topicIds,
    }
    writeFileSync(join(lecturesDir, `${track.id}.json`), JSON.stringify(record))
    fullCount++
  }

  db.close()

  console.log('')
  console.log(`Index entries:        ${index.length}`)
  console.log(`Topics indexed:       ${topicsIndex.length}`)
  console.log(`Collections / groups: ${Object.keys(collectionsById).length} / ${collectionGroups.length}`)
  console.log(`Tracks w/ transcript: ${fullCandidates.length}`)
  console.log(`Full records written: ${fullCount} (SYNC_LIMIT=${SYNC_LIMIT})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
