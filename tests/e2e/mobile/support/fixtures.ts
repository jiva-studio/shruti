import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** tests/e2e/mobile */
export const E2E_ROOT = path.resolve(__dirname, "..")
/** repo root (…/shruti) — e2e is three levels deep under it. */
export const REPO_ROOT = path.resolve(E2E_ROOT, "../../..")
export const FIXTURES_DIR = path.resolve(E2E_ROOT, "fixtures")

export const CONTENT_DB_PATH = path.resolve(FIXTURES_DIR, "content.db")
export const SILENT_MP3_PATH = path.resolve(FIXTURES_DIR, "silent.mp3")
export const TRANSCRIPT_JSON_PATH = path.resolve(FIXTURES_DIR, "transcript.json")

export type Locale = "en" | "ru"

export function userDbPath(locale: Locale): string {
  return path.resolve(FIXTURES_DIR, `user-${locale}.db`)
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
  TRANSCRIPT_JSON_PATH,
  userDbPath("en"),
  userDbPath("ru"),
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
