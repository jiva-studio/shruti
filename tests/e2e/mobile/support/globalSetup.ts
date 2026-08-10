import { execFileSync } from "child_process"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import { CONTENT_DB_PATH, E2E_ROOT, missingFixtures } from "./fixtures.js"

/**
 * Guard what the whole suite is about to run against.
 *
 * The catalog fixture is a COMMITTED asset (`fixtures/content.db`), so a run on
 * one branch is comparable with a run on another. This used to re-copy it from
 * the local lake whenever the lake was newer — which meant two runs of the same
 * commit hours apart tested different corpora, and a spec could "regress"
 * because content was published in between (issue #1539). The corpus now moves
 * only when someone rebuilds the fixture on purpose
 * (`scripts/build-catalog-fixture.py`) and commits it.
 *
 * So: verify the catalog is byte-for-byte the one recorded beside it, and FAIL
 * if it isn't — a silently different corpus is exactly what makes an E2E result
 * meaningless. The seeded user DBs are still generated locally (their listening
 * history is anchored to the generation day), so a missing one still triggers a
 * best-effort `prepare-fixtures.sh`; when that can't run, the per-test
 * `test.skip(!fixturesReady())` guard keeps the auto `e2e` job green.
 */

const PREPARE_SCRIPT = path.resolve(E2E_ROOT, "scripts/prepare-fixtures.sh")
const CONTENT_DB_META = `${CONTENT_DB_PATH}.json`

function verifyCatalogFixture(): void {
  if (!fs.existsSync(CONTENT_DB_PATH) || !fs.existsSync(CONTENT_DB_META)) return
  const expected = (JSON.parse(fs.readFileSync(CONTENT_DB_META, "utf-8")) as { sha256: string })
    .sha256
  const actual = crypto.createHash("sha256").update(fs.readFileSync(CONTENT_DB_PATH)).digest("hex")
  if (actual !== expected) {
    throw new Error(
      `${CONTENT_DB_PATH} does not match the digest in ${CONTENT_DB_META}\n` +
        `  expected ${expected}\n  actual   ${actual}\n` +
        "Restore it with `git checkout -- fixtures/content.db`, or rebuild it deliberately " +
        "with scripts/build-catalog-fixture.py and commit both files."
    )
  }
}

export default function globalSetup(): void {
  verifyCatalogFixture()

  try {
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
