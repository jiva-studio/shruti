import { execFileSync } from "child_process"
import fs from "fs"
import path from "path"
import { CONTENT_DB_PATH, E2E_ROOT, REPO_ROOT, missingFixtures } from "./fixtures.js"

/**
 * Make the suite pull its own fixtures so a run never silently uses a missing —
 * or, worse, a STALE — catalog. The binary fixtures (catalog `content.db`, the
 * seeded user DBs) are gitignored and were previously only checked for
 * *presence*: a `content.db` snapshotted before, say, topics were assigned to
 * their lectures would pass the guard and quietly make whole features look
 * empty (an English library with no topic tiles, etc.). This setup:
 *
 *   1. Re-copies `content.db` from the local lake catalog whenever the lake is
 *      newer than the snapshot — the lake is the source of truth, so the fixture
 *      tracks it automatically instead of going stale.
 *   2. Runs `prepare-fixtures.sh` to fetch anything still missing.
 *
 * Both steps are best-effort: on a plain checkout with no lake and no network
 * the prepare can't run, and we deliberately don't fail here — the per-test
 * `test.skip(!fixturesReady())` guard then keeps the auto `e2e` job green.
 */

/** Published catalog produced by the local lake pipeline — the fixture's source. */
const LAKE_CATALOG = path.resolve(REPO_ROOT, "resources/lake-out/artifacts/catalog/current.db")
const PREPARE_SCRIPT = path.resolve(E2E_ROOT, "scripts/prepare-fixtures.sh")

export default function globalSetup(): void {
  try {
    if (
      fs.existsSync(LAKE_CATALOG) &&
      fs.existsSync(CONTENT_DB_PATH) &&
      fs.statSync(LAKE_CATALOG).mtimeMs > fs.statSync(CONTENT_DB_PATH).mtimeMs
    ) {
      fs.copyFileSync(LAKE_CATALOG, CONTENT_DB_PATH)
      console.log("[e2e] refreshed content.db from the newer lake catalog")
    }

    if (missingFixtures().length > 0) {
      console.log("[e2e] fixtures missing — running prepare-fixtures.sh")
      execFileSync("bash", [PREPARE_SCRIPT], { cwd: E2E_ROOT, stdio: "inherit" })
    }
  } catch (err) {
    // Don't fail the run: the per-test fixture guard skips when they're absent.
    console.warn(
      `[e2e] fixture auto-prepare skipped: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
