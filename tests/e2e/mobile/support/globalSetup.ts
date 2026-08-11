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
const CASES_PATH = path.resolve(E2E_ROOT, "qase/cases.json")
const DIST_DIR = path.resolve(E2E_ROOT, "../../../modules/apps/mobile/dist")

/**
 * In bundle mode the suite serves a PREBUILT `dist/`, and a dist built the
 * ordinary way has no test seam in it: the subscription override is compiled
 * out, so every `boot({ pro: true })` spec runs as a FREE user against the
 * wrong UI — passing or failing for reasons that have nothing to do with the
 * behaviour under test (#1633).
 *
 * The build leaves a `dist/e2e-build` marker when (and only when) it was made
 * with `SHRUTI_E2E_BUILD=1`. Refuse to start without it, rather than let a
 * whole run report against a tier nobody chose.
 */
function verifyBundleIsTestBuild(): void {
  if (process.env.E2E_USE_BUNDLE !== "1") return
  if (fs.existsSync(path.join(DIST_DIR, "e2e-build"))) return
  throw new Error(
    `E2E_USE_BUNDLE=1 but ${DIST_DIR} was not built for the tests.\n` +
      "Its subscription seam is compiled out, so every `pro: true` spec would " +
      "silently run as a free user.\n" +
      "Build it with `npm run build:bundle` (from tests/e2e/mobile), or drop " +
      "E2E_USE_BUNDLE to use the dev server."
  )
}

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


/**
 * The registry and the specs must agree, or a green run reports the wrong thing.
 *
 * Every result is filed under the id in `qase(id, …)` and displayed under the
 * name `caseTitle(n)` returns, and nothing makes those two the same number. A
 * renumbering pass that rewrote one and not the other produced five specs that
 * reported against their own case while showing another case's title — with
 * every test passing, which is why it has to be checked rather than noticed.
 *
 * Also checked: an id no entry describes (`caseTitle` throws mid-run, after the
 * suite has already spent minutes booting), and a `step()` index past the end
 * of its case's steps.
 */
function verifyCaseRegistry(): void {
  const registry = JSON.parse(fs.readFileSync(CASES_PATH, "utf-8")) as Record<
    string,
    { steps?: unknown[] }
  >
  const problems: string[] = []

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) return walk(full)
      return e.isFile() && e.name.endsWith(".spec.ts") ? [full] : []
    })

  for (const file of walk(path.resolve(E2E_ROOT, "tests"))) {
    const src = fs.readFileSync(file, "utf-8")
    const where = path.relative(E2E_ROOT, file)

    for (const [, id, titleId] of src.matchAll(/qase\(\s*(\d+)\s*,\s*caseTitle\(\s*(\d+)\s*\)/g)) {
      if (id !== titleId) {
        problems.push(`${where}: reports as case ${id} but displays case ${titleId}'s title`)
      }
    }
    for (const [, id] of src.matchAll(/qase\(\s*(\d+)\s*,/g)) {
      if (!registry[id]) problems.push(`${where}: case ${id} is in no registry entry`)
    }
    for (const [, id, index] of src.matchAll(/step\(\s*page\s*,\s*(\d+)\s*,\s*(\d+)\s*,/g)) {
      const steps = registry[id]?.steps?.length ?? 0
      if (Number(index) >= steps) {
        problems.push(`${where}: case ${id} step ${index} — the entry describes ${steps}`)
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Qase registry and specs disagree:\n  ${problems.join("\n  ")}\n` +
        "Every result would be filed or labelled wrong. Fix qase/cases.json or the spec."
    )
  }
}

export default function globalSetup(): void {
  verifyCatalogFixture()
  verifyBundleIsTestBuild()
  verifyCaseRegistry()

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
