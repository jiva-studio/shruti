import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** tests/e2e/mobile */
export const E2E_ROOT = path.resolve(__dirname, "..")
/** repo root (…/lectorium) — e2e is three levels deep under it. */
export const REPO_ROOT = path.resolve(E2E_ROOT, "../../..")
export const FIXTURES_DIR = path.resolve(E2E_ROOT, "fixtures")

export const CONTENT_DB_PATH = path.resolve(FIXTURES_DIR, "content.db")
export const SILENT_MP3_PATH = path.resolve(FIXTURES_DIR, "silent.mp3")
/**
 * A track that ENDS. The default stub is 300s, deliberately longer than any
 * spec, so playback never finishes under a test that did not ask for it —
 * which also means nothing could ever exercise what happens when a lecture
 * runs out. Specs about completion serve this one instead.
 */
export const SILENT_3S_MP3_PATH = path.resolve(FIXTURES_DIR, "silent-3s.mp3")
export const TRANSCRIPT_JSON_PATH = path.resolve(FIXTURES_DIR, "transcript.json")
export const COVER_PNG_PATH = path.resolve(FIXTURES_DIR, "cover-sample.png")

export type Locale = "en" | "ru"

/** Which seeded user.db a test loads (mirrors the generator's strategy names):
 *  - "preseed" — playlist + listening history + notes + chat (the default).
 *  - "clean"   — schema + config only; for specs that bring their own state, so
 *    their screenshots show an empty home instead of the seeded dataset.
 *  - "single"  — exactly one queued, downloaded track; for "play the first
 *    queued track" specs that need one track, not the full demo queue.
 *  - "queue"   — 60 queued tracks, past the playlist's page size and the native
 *    queue window (both 50), so an item beyond the loaded page exists at all. */
export type UserDbStrategy = "preseed" | "clean" | "single" | "queue"

/** Filename suffix per strategy — must match generate-fixtures STRATEGIES. */
const USER_DB_SUFFIX: Record<UserDbStrategy, string> = {
  preseed: "",
  clean: ".clean",
  single: ".single",
  queue: ".queue",
}

export function userDbPath(locale: Locale, strategy: UserDbStrategy = "preseed"): string {
  return path.resolve(FIXTURES_DIR, `user-${locale}${USER_DB_SUFFIX[strategy]}.db`)
}

/**
 * The app validates the catalog DB against its compile-time SUPPORTED_DB_SCHEME
 * (Vite `define` from modules/db-scheme.json). Read it dynamically so a scheme
 * bump doesn't silently strand Welcome on the loading screen. The synthesised
 * pinned version is `${scheme}000000`; its first 8 digits ARE the scheme, which
 * is what the fake config hands back to Welcome.
 */
const DB_SCHEME: number = (
  JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, "modules/db-scheme.json"), "utf-8")) as {
    scheme: number
  }
).scheme
export const CONTENT_DB_VERSION = Number(`${DB_SCHEME}000000`)

const REQUIRED_FIXTURES = [
  CONTENT_DB_PATH,
  SILENT_MP3_PATH,
  SILENT_3S_MP3_PATH,
  TRANSCRIPT_JSON_PATH,
  userDbPath("en"),
  userDbPath("ru"),
  userDbPath("en", "clean"),
  userDbPath("ru", "clean"),
  userDbPath("en", "single"),
  userDbPath("ru", "single"),
  userDbPath("en", "queue"),
  userDbPath("ru", "queue"),
]

/** Fixtures that haven't been prepared yet (gitignored binaries). */
export function missingFixtures(): string[] {
  return REQUIRED_FIXTURES.filter((p) => !fs.existsSync(p))
}

/** True when every fixture the suite needs is on disk. */
export function fixturesReady(): boolean {
  return missingFixtures().length === 0
}

export function assertFixturesPresent(): void {
  const missing = missingFixtures()
  if (missing.length > 0) {
    throw new Error(
      `Missing E2E fixtures:\n  ${missing.join("\n  ")}\n` +
        `Run ./scripts/prepare-fixtures.sh from tests/e2e/mobile (see README).`
    )
  }
}
