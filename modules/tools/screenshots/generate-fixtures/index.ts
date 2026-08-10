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
 * `@lectorium`, `@lib/*` aliases (defined in vite.config.ts) resolve against
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
import { runUserMigrations } from "@infra/persistence/migrations/user/runMigrations.js"
import { playlistTracksFor, demoTranscriptTrackId } from "./tracks.js"
import {
  chatFixtureFor,
  mediaChatFixtureFor,
  DEMO_SESSION_ID,
  DEMO_MEDIA_SESSION_ID,
  type ChatFixture,
} from "./chat.js"
import { CAPTURE_LOCALES, contentLanguageFor } from "../config.js"

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
  strategy: StrategyName
  /** Catalog the `queue` strategy draws its track ids from. */
  catalog: string
}

/** Raw CLI options. `locale`/`out` are resolved per-locale in main(). */
interface CliOpts {
  locale?: string
  out?: string
  seed: number
  days: number
  now: number
  strategy: StrategyName
  catalog: string
}

function parseArgs(argv: string[]): CliOpts {
  const opts: Record<string, string> = {}
  for (const arg of argv) {
    // `--clean` is sugar for `--strategy=clean`.
    if (arg === "--clean") {
      opts.strategy = "clean"
      continue
    }
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m) opts[m[1]!] = m[2]!
  }
  const strategy = (opts.strategy ?? "preseed") as StrategyName
  if (!(strategy in STRATEGIES)) {
    throw new Error(
      `unknown --strategy=${strategy}; known: ${Object.keys(STRATEGIES).join(", ")}`
    )
  }
  return {
    locale: opts.locale,
    out: opts.out,
    strategy,
    catalog: opts.catalog ?? defaultCatalogPath(),
    seed: opts.seed ? Number(opts.seed) : 42,
    days: opts.days ? Number(opts.days) : 120,
    // Anchor to the START of the generation day (local midnight), NOT a
    // frozen date. The activity heatmap computes "today" and the streak
    // from the real clock at render time, so a hardcoded `now` drifts:
    // as days pass the current-day cell marches away from the seeded
    // sessions and the streak vanishes. Capture runs the same day as
    // generation (CI does both back-to-back), so today's local-day cell
    // lines up with the seeded streak. Midnight (not Date.now()) keeps
    // each day's sessions — which fan out up to +15h — inside their own
    // calendar day instead of spilling into tomorrow.
    now: opts.now ? Number(opts.now) : startOfLocalDay(),
  }
}

/** Local-midnight (00:00) of the current day, in unix ms. */
function startOfLocalDay(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
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

/* ------------------------------ Strategies ----------------------------- */

/**
 * A fixture strategy decides what user state a generated `user.db` carries
 * beyond the always-present schema + config. Adding a new flavour (e.g. a
 * signed-in or notes-only fixture) is one new entry here — no boolean flags.
 *
 *  - `suffix` — appended to the default output filename (`user-<locale><suffix>.db`).
 *  - `seed`   — populates the db after migrations + config have run.
 */
interface Strategy {
  suffix: string
  seed: (db: IDatabase, args: Args, rng: () => number) => Promise<void>
}

const STRATEGIES = {
  /** Full demo dataset: playlist, listening history, notes, chat. */
  preseed: {
    suffix: "",
    seed: async (db, args, rng) => {
      const itemIds = await seedPlaylist(db, args, rng)
      console.log(`  wrote ${itemIds.length} playlist_items`)
      await seedMediaItems(db, args, playlistTracksFor(args.locale), rng)
      await seedSessions(db, args, itemIds, rng)
      await seedNotes(db, args, rng)
      await seedChat(db, args)
    },
  },
  /** Minimal: schema + config only, so specs that bring their own state show
   *  an empty home (no seeded playlist / history / notes) in screenshots. */
  clean: {
    suffix: ".clean",
    seed: async () => {
      console.log("  clean strategy — schema + config only (no playlist/history/notes/chat)")
    },
  },
  /**
   * A queue longer than one page of it.
   *
   * The playlist loads in pages and keeps a bounded window of the native
   * queue, so everything about "an item past the loaded page" — resolving it,
   * archiving it, playing it — is unreachable while the seeded queue is nine
   * rows. This seeds past that boundary, with real tracks read from the
   * catalog rather than a hand-kept list, because the point is the count.
   */
  queue: {
    suffix: ".queue",
    seed: async (db, args, rng) => {
      const tracks = await catalogTracks(args, QUEUE_ITEMS)
      for (let i = 0; i < tracks.length; i++) {
        await db.execute(
          "INSERT INTO playlist_items (id, track_id, added_at, archived_at) VALUES (?, ?, ?, NULL)",
          [`pli_${nanoId(rng)}`, tracks[i]!, args.now - i * 60 * 60 * 1000]
        )
      }
      console.log(`  queue strategy — ${tracks.length} queued tracks, no history/notes/chat`)
    },
  },
  /** One queued, downloaded track and nothing else — for "play the first queued
   *  track" specs (player / transcript / notes / mixer) that need exactly one
   *  track. Keeps the Home queue a single row instead of the full demo set, so
   *  the player screenshots aren't buried under nine seeded lectures. */
  single: {
    suffix: ".single",
    seed: async (db, args, rng) => {
      const [track] = playlistTracksFor(args.locale)
      await db.execute(
        "INSERT INTO playlist_items (id, track_id, added_at, archived_at) VALUES (?, ?, ?, NULL)",
        [`pli_${nanoId(rng)}`, track, args.now]
      )
      await seedMediaItems(db, args, [track!], rng)
      console.log(`  single strategy — 1 queued track (${track}), no history/notes/chat`)
    },
  },
} satisfies Record<string, Strategy>

type StrategyName = keyof typeof STRATEGIES

/* ---------------------------- Catalog reads ---------------------------- */

/**
 * Long enough to sit past the playlist's page size and the native queue window
 * (both 50), so an item beyond the loaded page exists to be resolved, archived
 * or played.
 */
const QUEUE_ITEMS = 60

const REPO_ROOT = path.resolve(TOOL_ROOT, "../../..")

/**
 * Where to read track ids from. The lake output is the real catalog and wins
 * when it is there; the e2e suite's committed carve-out stands in when it is
 * not, which is the usual case on a fresh checkout.
 */
function defaultCatalogPath(): string {
  const lake = path.resolve(REPO_ROOT, "resources/lake-out/artifacts/catalog/current.db")
  if (fs.existsSync(lake)) return lake
  return path.resolve(REPO_ROOT, "tests/e2e/mobile/fixtures/content.db")
}

/**
 * `count` tracks that have audio in the locale's content language, ordered by
 * id so two runs against the same catalog pick the same ones.
 */
async function catalogTracks(args: Args, count: number): Promise<string[]> {
  if (!fs.existsSync(args.catalog)) {
    throw new Error(
      `catalog not found at ${args.catalog} — pass --catalog=<path to a published catalog>`
    )
  }
  const SQL = await initSqlJs()
  const catalog = new SQL.Database(fs.readFileSync(args.catalog))
  try {
    const language = contentLanguageFor(args.locale)
    const rows = catalog.exec(
      `SELECT DISTINCT t.id FROM tracks t
         JOIN track_variants v ON v.track_id = t.id
         JOIN track_audio a ON a.track_id = t.id
        WHERE v.language = '${language}' AND COALESCE(t.hidden, 0) = 0
        ORDER BY t.id LIMIT ${count}`
    )
    const ids = (rows[0]?.values ?? []).map((r) => String(r[0]))
    if (ids.length < count) {
      throw new Error(
        `catalog ${args.catalog} yielded only ${ids.length} ${language} tracks with audio, need ${count}`
      )
    }
    return ids
  } finally {
    catalog.close()
  }
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

  // Mark every item EXCEPT the four most-recently-added as finished, so
  // the Home view reads as a mostly-completed queue with several
  // still-in-progress lectures at the bottom — not a uniform column of
  // checkmarks. `to_position` way above any real lecture length trips the
  // `isCompletedSec(toPosition, durationSec)` check for every track.
  //
  // Items are added newest-first — index 0 is the most recent — and the
  // Up Next list renders oldest-at-top, so `slice(IN_PROGRESS_COUNT)` is
  // everything but the bottom rows. Four in-progress keeps at least one of
  // them visible above the floating player on the short Surface Duo
  // viewport (which only shows ~6 of the 9 rows), while filling the
  // taller phone viewport with the rest.
  const IN_PROGRESS_COUNT = 4
  const completedItems = itemIds.slice(IN_PROGRESS_COUNT)
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

  // The bottom two rows stay deliberately UNFINISHED ("not yet listened").
  // The random per-day loop above may have handed them a long `to_position`
  // that would trip completion (real lectures run ~30 min, sessions reach
  // up to ~60 min). CAP those rows instead of deleting them — a delete
  // would punch holes in the daily totals and shorten the current streak
  // when one of these items was a day's only session. Capping keeps every
  // day it touched non-empty while guaranteeing `to_position` never reaches
  // the lecture end. Then pin the LATEST session to a fixed partial value
  // so the in-progress radial is deterministic.
  const inProgressItems = itemIds.slice(0, IN_PROGRESS_COUNT)
  const partialToPosition = [400, 700, 1000, 1300] // seconds into a ~30-min lecture
  for (let k = 0; k < inProgressItems.length; k++) {
    const item = inProgressItems[k]!
    const toPos = partialToPosition[k] ?? 600
    // `getProgressForItems` reads the high-water mark (MAX(to_position)), so
    // cap any prior session on this item to the intended partial — otherwise
    // a longer random session would drive the radial instead of THIS one.
    await db.execute(
      "UPDATE listening_sessions SET from_position = 0, to_position = ? WHERE item_id = ? AND to_position > ?",
      [toPos, item, toPos]
    )
    const startedAt = Math.floor(args.now / 1000) + 23 * 60 * 60
    await db.execute(
      `INSERT INTO listening_sessions
         (id, item_id, started_at, ended_at, from_position, to_position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`ls_${nanoId(rng)}`, item, startedAt, startedAt + toPos, 0, toPos]
    )
    total++
  }

  await clampDailyTotals(db)

  console.log(
    `  wrote ${total} listening_sessions across ${args.days} days ` +
      `(${completedItems.length} completed, ${inProgressItems.length} in-progress)`
  )
}

/** Heatmap intensity ceiling (sec/day). The grid has four shades keyed on
 *  daily listening time, the darkest being ≥2h. A lone day that randomly
 *  spikes past 2h renders as a single very-dark cell that reads as an
 *  outlier against the lighter gradient. Cap below the 2h tier so the
 *  heatmap stays a smooth tiers-1–3 gradient with no glaring cell. */
const DAILY_INTENSITY_CAP_SEC = 6000 // 1h40m — comfortably inside tier 3 (<2h)

/**
 * Scale down any day whose summed listening time exceeds
 * `DAILY_INTENSITY_CAP_SEC`, preserving each session's share so relative
 * intensity is kept. Completion markers (`to_position` ≈ 999999) carry no
 * listening time and are excluded. Runs last so it also tames the
 * in-progress fills — but the pinned 23:00 partials sit on `today`, whose
 * total stays well under the cap, so the deterministic radials survive.
 */
async function clampDailyTotals(db: IDatabase): Promise<void> {
  const rows = await db.query<{
    id: string
    started_at: number
    from_position: number
    to_position: number
  }>(
    `SELECT id, started_at, from_position, to_position FROM listening_sessions
     WHERE to_position - from_position BETWEEN 0 AND 100000`
  )
  const byDay = new Map<number, typeof rows>()
  for (const r of rows) {
    const d = new Date(r.started_at * 1000)
    d.setHours(0, 0, 0, 0)
    const key = d.getTime()
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(r)
  }
  for (const sessions of byDay.values()) {
    const total = sessions.reduce((s, r) => s + (r.to_position - r.from_position), 0)
    if (total <= DAILY_INTENSITY_CAP_SEC) continue
    const factor = DAILY_INTENSITY_CAP_SEC / total
    for (const r of sessions) {
      const scaled = Math.max(1, Math.round((r.to_position - r.from_position) * factor))
      await db.execute("UPDATE listening_sessions SET to_position = ? WHERE id = ?", [
        r.from_position + scaled,
        r.id,
      ])
    }
  }
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

// Transcript fixture committed under fixtures/transcripts/<id>/<lang>.json —
// the exact doc the capture serves into the dialog, so the seeded bookmarks
// line up with the rendered blocks. No S3 at gen or capture time.
const TRANSCRIPTS_DIR = path.join(TOOL_ROOT, "fixtures", "transcripts")

async function seedNotes(db: IDatabase, args: Args, rng: () => number): Promise<void> {
  const trackId = demoTranscriptTrackId(args.locale)
  // Transcripts only exist in the content language (en/ru); a UI locale like
  // sr-Latn falls back to the English demo track + transcript.
  const transcriptFile = path.join(TRANSCRIPTS_DIR, trackId, `${contentLanguageFor(args.locale)}.json`)
  if (!fs.existsSync(transcriptFile)) {
    console.warn(`  transcript fixture missing ${transcriptFile} — skipping notes seed`)
    return
  }
  const doc = JSON.parse(fs.readFileSync(transcriptFile, "utf-8")) as TranscriptDoc
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

async function seedChat(db: IDatabase, args: Args): Promise<void> {
  // Two demo sessions: the soul Q&A (verse + citation cards) and the
  // remembrance Q&A (media video card). Stagger their creation so the
  // recent-chats list has a stable order; each scenario opens its own
  // session directly via the debug bridge.
  await seedChatSession(
    db,
    DEMO_SESSION_ID,
    chatFixtureFor(args.locale),
    args.now - 30 * 60 * 1000,
    args.now
  )
  await seedChatSession(
    db,
    DEMO_MEDIA_SESSION_ID,
    mediaChatFixtureFor(args.locale),
    args.now - 20 * 60 * 1000,
    args.now
  )
}

async function seedChatSession(
  db: IDatabase,
  sessionId: string,
  fixture: ChatFixture,
  sessionCreatedAt: number,
  updatedAt: number
): Promise<void> {
  await db.execute(
    `INSERT INTO chat_sessions (id, title, created_at, updated_at, track_id)
     VALUES (?, ?, ?, ?, NULL)`,
    [sessionId, fixture.sessionTitle, sessionCreatedAt, updatedAt]
  )
  // Stagger message timestamps by 1s so listBySession's
  // ORDER BY created_at ASC keeps user-before-assistant order even
  // though they were inserted within the same wall-clock second.
  for (let i = 0; i < fixture.messages.length; i++) {
    const msg = fixture.messages[i]!
    const createdAt = sessionCreatedAt + i * 1_000
    // Verse / cite / media bodies ride the message's `meta` envelope (the
    // persisted form of the server's SSE payloads). The renderer reads them
    // off the message and only shows the small chip when a body is absent —
    // so this is what makes the screenshot render the full cards.
    const data: Record<string, unknown> = {}
    if (msg.verses) data.verses = msg.verses
    if (msg.cites) data.cites = msg.cites
    if (msg.media) data.media = msg.media
    const meta = JSON.stringify({ _v: 1, data })
    await db.execute(
      `INSERT INTO chat_messages
         (id, session_id, role, content, created_at, meta)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [msg.id, sessionId, msg.role, msg.content, createdAt, meta]
    )
  }
  console.log(`  wrote chat session "${fixture.sessionTitle}" with ${fixture.messages.length} messages`)
}

/* -------------------------------- Main -------------------------------- */

async function buildOne(args: Args): Promise<void> {
  const rng = mulberry32(args.seed)

  console.log(
    `→ generating user fixture: locale=${args.locale} strategy=${args.strategy} ` +
      `seed=${args.seed} days=${args.days}`
  )
  console.log(`  output: ${args.out}`)

  const SQL = await initSqlJs()
  const raw = new SQL.Database()
  const db = wrapDatabase(raw)

  await runUserMigrations(db)
  // The migration runner stamps each row with the wall clock, which is the only
  // thing left in this file that differs between two runs on the same day — and
  // it made the fixture bytes differ, so two E2E runs of one commit could not be
  // compared (issue #1539). Restamp to the run's `now` anchor.
  await db.execute("UPDATE migrations SET applied_at = ?", [new Date(args.now).toISOString()])
  await seedConfig(db, args)
  await STRATEGIES[args.strategy].seed(db, args, rng)

  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  const bytes = raw.export()
  fs.writeFileSync(args.out, bytes)
  console.log(`✓ wrote ${args.out} (${bytes.length} bytes)`)

  raw.close()
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2))
  // No --locale → build the whole capture set (config.CAPTURE_LOCALES);
  // --locale=xx builds just that one.
  const locales = cli.locale ? [cli.locale] : [...CAPTURE_LOCALES]
  const { suffix } = STRATEGIES[cli.strategy]
  for (const locale of locales) {
    const out = cli.out ?? path.join(DEFAULT_OUT_DIR, `user-${locale}${suffix}.db`)
    await buildOne({
      locale,
      out,
      seed: cli.seed,
      days: cli.days,
      now: cli.now,
      strategy: cli.strategy,
      catalog: cli.catalog,
    })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
