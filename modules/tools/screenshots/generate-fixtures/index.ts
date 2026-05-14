/**
 * Generates a deterministic user.db fixture for the screenshots pipeline.
 *
 * Populates:
 *  - `config`         — locale + welcome flag so the home screen comes up immediately
 *  - `playlist_items` — handful of real tracks from the published catalog
 *  - `listening_sessions` — 120 days of varied sessions → heatmap with current streak
 *  - `notes`          — 4 bookmarks on the demo transcript track
 *
 * Runs via vite-node with cwd = modules/apps/mobile so the `@ports`, `@infra`,
 * `@shruti`, `@lib/*` aliases (defined in vite.config.ts) resolve against
 * the real production code. The script lives here under tools/screenshots
 * because its output is consumed by the capture spec.
 *
 * Invoke from the tool root: `npm run generate-user-fixture`.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import initSqlJs, { type Database } from "sql.js"
import type { IDatabase, QueryParams } from "@ports/app/index.js"
import { runUserMigrations } from "@shruti/services/migrations/user/runMigrations.js"
import { playlistTracksFor, demoTranscriptTrackId } from "./tracks.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOOL_ROOT = path.resolve(__dirname, "..")
const DEFAULT_OUT_DIR = path.resolve(TOOL_ROOT, "fixtures")

/* ------------------------------- CLI ------------------------------ */

interface Args {
  locale: string
  out: string
  seed: number
  days: number
  now: number
}

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string> = {}
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) opts[m[1]!] = m[2]!
  }
  const locale = opts.locale ?? "en"
  const out = opts.out ?? path.join(DEFAULT_OUT_DIR, `user-${locale}.db`)
  return {
    locale,
    out,
    seed: opts.seed ? Number(opts.seed) : 42,
    days: opts.days ? Number(opts.days) : 120,
    now: opts.now ? Number(opts.now) : Date.parse("2026-05-13T09:00:00Z"),
  }
}

/* -------------------------- mulberry32 PRNG ---------------------------- */

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* --------------------------- IDatabase shim ---------------------------- */

function wrapDatabase(db: Database): IDatabase {
  return {
    async query<T = unknown>(sql: string, params?: QueryParams): Promise<T[]> {
      const stmt = db.prepare(sql)
      if (params?.length) stmt.bind(params as never)
      const results: T[] = []
      while (stmt.step()) results.push(stmt.getAsObject() as T)
      stmt.free()
      return results
    },
    async execute(sql: string, params?: QueryParams): Promise<void> {
      db.run(sql, params as never)
    },
    async transaction(fn: () => Promise<void>): Promise<void> {
      try {
        db.run("BEGIN")
        await fn()
        db.run("COMMIT")
      } catch (err) {
        db.run("ROLLBACK")
        throw err
      }
    },
    async save(): Promise<void> {
      /* no-op for the in-memory fixture; main() dumps via db.export() */
    },
    async close(): Promise<void> {
      db.close()
    },
  }
}

/* --------------------------- ID generation ---------------------------- */

function nanoId(rng: () => number, len = 12): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
  let id = ""
  for (let i = 0; i < len; i++) id += alphabet[Math.floor(rng() * alphabet.length)]
  return id
}

/* ------------------------------- Seeders ------------------------------ */

async function seedConfig(db: IDatabase, args: Args): Promise<void> {
  const rows: [string, string][] = [
    ["settings.appLanguage", JSON.stringify(args.locale)],
    ["settings.notes.showTab", JSON.stringify(true)],
    ["settings.openTranscriptAutomatically", JSON.stringify(true)],
    ["settings.audio.mixPosition", JSON.stringify(0)],
    ["settings.audio.playbackSpeed", JSON.stringify(1)],
  ]
  for (const [k, v] of rows) {
    await db.execute("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", [k, v])
  }
}

async function seedPlaylist(db: IDatabase, args: Args, rng: () => number): Promise<string[]> {
  const tracks = playlistTracksFor(args.locale)
  const itemIds: string[] = []
  // Add items spread over the last 30 days so "added at" timestamps look
  // organic in the UI (they drive list order; the heatmap is independent).
  for (let i = 0; i < tracks.length; i++) {
    const id = `pli_${nanoId(rng)}`
    const addedAt = args.now - i * 3 * 24 * 60 * 60 * 1000
    await db.execute(
      "INSERT INTO playlist_items (id, track_id, added_at, archived_at) VALUES (?, ?, ?, NULL)",
      [id, tracks[i]!, addedAt]
    )
    itemIds.push(id)
  }
  return itemIds
}

async function seedMediaItems(
  db: IDatabase,
  args: Args,
  trackIds: readonly string[],
  rng: () => number
): Promise<void> {
  // Mark every playlist track as fully downloaded so the Home view's
  // download indicator shows them as ready (rather than "still
  // downloading / not on disk"). useDownloadStore hydrates from
  // `media_items WHERE state = 'ready'`.
  for (const trackId of trackIds) {
    await db.execute(
      `INSERT INTO media_items (id, track_id, state, local_path, created_at)
       VALUES (?, ?, 'ready', NULL, ?)`,
      [`mi_${nanoId(rng)}`, trackId, args.now - Math.floor(rng() * 7 * 24 * 60 * 60 * 1000)]
    )
  }
  console.log(`  wrote ${trackIds.length} media_items (state=ready)`)
}

async function seedSessions(
  db: IDatabase,
  args: Args,
  itemIds: readonly string[],
  rng: () => number
): Promise<void> {
  if (itemIds.length === 0) return

  const oneDayMs = 24 * 60 * 60 * 1000
  // listening_sessions stores unix SECONDS, positions in seconds
  let total = 0

  for (let dayOffset = args.days - 1; dayOffset >= 0; dayOffset--) {
    const r = rng()
    let sessions: number
    if (dayOffset < 10) sessions = 1 + Math.floor(rng() * 3) // current streak: every day, 1..3
    else if (r < 0.25) sessions = 0
    else if (r < 0.55) sessions = 1
    else if (r < 0.85) sessions = 2
    else sessions = 3 + Math.floor(rng() * 2)

    const dayStartMs = args.now - dayOffset * oneDayMs

    for (let i = 0; i < sessions; i++) {
      const item = itemIds[Math.floor(rng() * itemIds.length)]!
      const hourOffset = Math.floor(rng() * 16) * 60 * 60 * 1000
      const lengthSec = 60 + Math.floor(rng() * 30 * 60) // 1..30 min
      const fromSec = Math.floor(rng() * 1800)
      const startedAt = Math.floor((dayStartMs + hourOffset) / 1000)
      const endedAt = startedAt + lengthSec
      await db.execute(
        `INSERT INTO listening_sessions
           (id, item_id, started_at, ended_at, from_position, to_position)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [`ls_${nanoId(rng)}`, item, startedAt, endedAt, fromSec, fromSec + lengthSec]
      )
      total++
    }
  }

  // Make the LAST half of the playlist look like the user already
  // finished listening — that gives the Home view a mix of "completed"
  // checkmarks and "in-progress" radials instead of a sea of empty
  // circles that visually reads as "nothing downloaded yet".
  // `to_position` way above any real lecture length trips the
  // `isCompletedSec(toPosition, durationSec)` check for every track.
  const completedItems = itemIds.slice(Math.ceil(itemIds.length / 2))
  let bias = 0
  for (const item of completedItems) {
    const startedAt = Math.floor((args.now - 2 * oneDayMs) / 1000) + bias
    // 4 seconds of "final playback" with `to_position` past every real
    // lecture length so `isCompletedSec(toPosition, durationSec)` trips.
    // Use to-from = 4 (NOT 999999) so this row doesn't inflate
    // `listenedSeconds` totals shown on Home / Activity.
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`ls_${nanoId(rng)}`, item, startedAt, startedAt + 4, 999_995, 999_999]
    )
    total++
    bias += 600
  }

  console.log(
    `  wrote ${total} listening_sessions across ${args.days} days (${completedItems.length} marked completed)`
  )
}

interface TranscriptBlock {
  type: string
  start: number
  end: number
  text: string
}
interface TranscriptDoc {
  blocks: TranscriptBlock[]
}

// Same S3 origin the runtime app fetches transcripts from — keeps the
// fixture in sync with what the user will see in the dialog at capture
// time, with no local-mirror dependency.
const TRANSCRIPT_BASE_URL = "https://cdn-s3.shruti.local/public/tracks"

async function seedNotes(db: IDatabase, args: Args, rng: () => number): Promise<void> {
  const trackId = demoTranscriptTrackId(args.locale)
  const transcriptUrl = `${TRANSCRIPT_BASE_URL}/${trackId}/transcripts/${args.locale}.json`
  let doc: TranscriptDoc
  try {
    const response = await fetch(transcriptUrl)
    if (!response.ok) {
      console.warn(`  transcript fetch ${response.status} ${transcriptUrl} — skipping notes seed`)
      return
    }
    doc = (await response.json()) as TranscriptDoc
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`  transcript fetch failed (${msg}) — skipping notes seed`)
    return
  }
  const sentences = doc.blocks.filter((b) => b.type === "sentence")
  // Pick blocks in the 150–400 char range so the bookmark snippet on the
  // Notes screen has 2–3 lines of readable text — not a single word and
  // not an entire chapter of obeisances. Fall back to longest-available
  // if the track doesn't have enough mid-length blocks.
  const SWEET_MIN = 150
  const SWEET_MAX = 400
  const sweet = sentences.filter((b) => b.text.length >= SWEET_MIN && b.text.length <= SWEET_MAX)
  const ranked =
    sweet.length >= 4
      ? sweet.sort((a, b) => b.text.length - a.text.length)
      : [...sentences].sort((a, b) => b.text.length - a.text.length)
  const picks = ranked.slice(0, Math.min(4, ranked.length))

  for (const block of picks) {
    const createdAt = args.now - Math.floor(rng() * 14 * 24 * 60 * 60 * 1000)
    await db.execute(
      `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`note_${nanoId(rng)}`, trackId, block.text, block.start, block.end, createdAt]
    )
  }
  console.log(`  wrote ${picks.length} notes on demo track ${trackId} (aligned to real blocks)`)
}

/* -------------------------------- Main -------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const rng = mulberry32(args.seed)

  console.log(`→ generating user fixture: locale=${args.locale} seed=${args.seed} days=${args.days}`)
  console.log(`  output: ${args.out}`)

  const SQL = await initSqlJs()
  const raw = new SQL.Database()
  const db = wrapDatabase(raw)

  await runUserMigrations(db)
  await seedConfig(db, args)
  const itemIds = await seedPlaylist(db, args, rng)
  console.log(`  wrote ${itemIds.length} playlist_items`)
  await seedMediaItems(db, args, playlistTracksFor(args.locale), rng)
  await seedSessions(db, args, itemIds, rng)
  await seedNotes(db, args, rng)

  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  const bytes = raw.export()
  fs.writeFileSync(args.out, bytes)
  console.log(`✓ wrote ${args.out} (${bytes.length} bytes)`)

  raw.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
