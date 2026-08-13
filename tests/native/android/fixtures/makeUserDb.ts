/**
 * Builds the older-schema user database that `specs/db-migration.spec.ts` puts
 * on the device, together with the manifest of what the current chain must make
 * of it.
 *
 * The fixture is the app's own migration chain, stopped at `--up-to` and seeded
 * with rows. The expectations are then read back from a SECOND copy that ran
 * the whole chain here, on this machine's SQLite — so nothing about the outcome
 * is written by hand, including migration 027's fold, which is easy to get
 * wrong on paper. What the spec compares is therefore "the device's engine"
 * against "a desktop engine", which is the only thing a device can add to the
 * unit tests that already cover what the migrations mean.
 *
 *   npx tsx fixtures/makeUserDb.ts [--up-to 016]
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { runMigrations } from "../../../../modules/kit/src/persistence/migrations.js"
import type { IDatabase } from "../../../../modules/kit/src/persistence/database.js"
import { userMigrations } from "../../../../modules/apps/mobile/infra/persistence/migrations/user/index.js"

const HERE = new URL("./", import.meta.url)
const FIXTURE = fileURLToPath(new URL("user-old.db", HERE))
const MANIFEST = fileURLToPath(new URL("user-old.json", HERE))
const REFERENCE = fileURLToPath(new URL("user-reference.tmp.db", HERE))

/** Tables the app does not write to on a passive launch — safe to compare row
 *  for row after the upgrade. */
const COMPARED = {
  notes: ["id", "track_id", "text", "time_start", "time_end", "created_at", "meta"],
  playlist_items: ["id", "track_id", "added_at", "archived_at", "collection_id"],
  listening_sessions: [
    "id",
    "item_id",
    "started_at",
    "ended_at",
    "from_position",
    "to_position",
    "source_key",
  ],
} as const

const SEED = [
  "INSERT INTO config (key, value) VALUES ('fixture.marker', 'user-old'), ('fixture.language', 'ru')",
  `INSERT INTO notes (id, track_id, text, time_start, time_end, created_at)
     VALUES ('note-1', 'track_fixture_a', 'a note written before the upgrade', 10, 40, 1700000000000)`,
  // Two rows for track_fixture_b: migration 027 folds them onto one and carries
  // the loser's listening sessions over, which is the data move this fixture is
  // here to see happen on the device.
  `INSERT INTO playlist_items (id, track_id, added_at, archived_at, collection_id) VALUES
     ('item-a',     'track_fixture_a', 1700000000000, NULL, NULL),
     ('item-b',     'track_fixture_b', 1700000100000, NULL, NULL),
     ('item-b-dup', 'track_fixture_b', 1700000200000, NULL, 'collection_fixture')`,
  `INSERT INTO listening_sessions (id, item_id, started_at, ended_at, from_position, to_position) VALUES
     ('session-1', 'item-a',     1700000300, 1700000400,  0, 120),
     ('session-2', 'item-b',     1700000500, 1700000600,  0,  90),
     ('session-3', 'item-b-dup', 1700000700, 1700000800, 90, 240)`,
]

function adapt(db: DatabaseSync): IDatabase {
  return {
    async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[]
    },
    async execute(sql: string, params: unknown[] = []): Promise<void> {
      if (params.length) db.prepare(sql).run(...(params as never[]))
      else db.exec(sql)
    },
    async transaction(fn: () => Promise<void>): Promise<void> {
      db.exec("BEGIN")
      try {
        await fn()
        db.exec("COMMIT")
      } catch (error) {
        db.exec("ROLLBACK")
        throw error
      }
    },
    async save(): Promise<void> {},
    async close(): Promise<void> {
      db.close()
    },
  }
}

function names(db: DatabaseSync, sql: string): string[] {
  return db
    .prepare(sql)
    .all()
    .map((row) => String(row.name))
}

const flag = process.argv.indexOf("--up-to")
const upTo = flag < 0 ? "016" : (process.argv[flag + 1] ?? "016")
const cut = userMigrations.findIndex((migration) => migration.name.startsWith(upTo))
if (cut < 0) throw new Error(`no migration starts with "${upTo}"`)

const applied = userMigrations.slice(0, cut + 1)
const pending = userMigrations.slice(cut + 1)
if (pending.length === 0) throw new Error(`nothing is pending above "${upTo}" — pick an older one`)

mkdirSync(fileURLToPath(HERE), { recursive: true })
rmSync(FIXTURE, { force: true })
rmSync(REFERENCE, { force: true })

const old = new DatabaseSync(FIXTURE)
await runMigrations(adapt(old), applied)
for (const statement of SEED) old.exec(statement)
old.close()

copyFileSync(FIXTURE, REFERENCE)
const reference = new DatabaseSync(REFERENCE)
await runMigrations(adapt(reference), userMigrations)

const tables = names(
  reference,
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
)
const manifest = {
  generatedAt: new Date().toISOString(),
  database: "user-old.db",
  appliedInFixture: applied.map((migration) => migration.name),
  pending: pending.map((migration) => migration.name),
  expected: {
    migrations: names(reference, "SELECT name FROM migrations ORDER BY name"),
    tables: Object.fromEntries(
      tables.map((table) => [table, names(reference, `PRAGMA table_info(${table})`).sort()]),
    ),
    indexes: names(
      reference,
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ),
    rows: Object.fromEntries(
      Object.entries(COMPARED).map(([table, columns]) => [
        table,
        reference
          .prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`)
          .all()
          .map((row) => ({ ...row })),
      ]),
    ),
    // The app writes its own keys here, so the spec only checks these survived.
    configEntries: reference
      .prepare("SELECT key, value FROM config WHERE key LIKE 'fixture.%' ORDER BY key")
      .all()
      .map((row) => ({ ...row })),
  },
}

reference.close()
rmSync(REFERENCE, { force: true })
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `[fixture] ${FIXTURE}\n` +
    `  stops after ${applied[applied.length - 1]!.name}, ${pending.length} migrations pending\n` +
    `  reference schema: ${tables.length} tables, ${manifest.expected.indexes.length} indexes`,
)
