import { describe, expect, it, vi } from "vitest"
import { sweepCatalogCopyTemps } from "../contentDatabase.js"

/**
 * #1896 — the native bundled-catalog helpers copy to `<file>.copying` and
 * rename it into place. That temp is cleared only from inside their own copy
 * step, which stops being entered once a newer catalog is on disk, so a kill
 * mid-copy strands up to ~54 MB that neither the versioned prune nor the
 * fetcher's `.download` cleanup can see.
 */

const TEMPLATE = "shruti/databases/shruti.{version}.db"
const DIR = "shruti/databases"

function store(files: readonly string[]) {
  const deleted: string[] = []
  return {
    deleted,
    list: vi.fn(async (dir: string) => (dir === DIR ? [...files] : [])),
    delete: vi.fn(async (path: string) => {
      deleted.push(path)
    }),
  }
}

describe("sweepCatalogCopyTemps", () => {
  it("deletes copy temps and leaves every real catalog alone", async () => {
    const s = store([
      `${DIR}/shruti.20260101000000.db`,
      `${DIR}/shruti.20260101000000.db.copying`,
      `${DIR}/shruti.20260202000000.db`,
      // The user DB shares the directory and must never be collateral.
      `${DIR}/user.db`,
    ])

    const swept = await sweepCatalogCopyTemps(s, TEMPLATE)

    expect(swept).toEqual([`${DIR}/shruti.20260101000000.db.copying`])
    expect(s.deleted).toEqual([`${DIR}/shruti.20260101000000.db.copying`])
  })

  it("sweeps a temp whose final catalog is long gone", async () => {
    // The orphan case: the copy was killed before the rename, then the JS
    // bootstrap downloaded a newer catalog — so `shouldCopy` is false forever
    // and nothing re-enters the native cleanup.
    const s = store([
      `${DIR}/shruti.20260303000000.db`,
      `${DIR}/shruti.20260101000000.db.copying`,
    ])

    expect(await sweepCatalogCopyTemps(s, TEMPLATE)).toEqual([
      `${DIR}/shruti.20260101000000.db.copying`,
    ])
  })

  it("keeps going when one delete fails", async () => {
    const s = store([`${DIR}/a.db.copying`, `${DIR}/b.db.copying`])
    s.delete.mockImplementationOnce(async () => {
      throw new Error("locked")
    })

    // The failed one stays for the next launch; the other still goes.
    expect(await sweepCatalogCopyTemps(s, TEMPLATE)).toEqual([`${DIR}/b.db.copying`])
  })

  it("returns nothing when the directory cannot be listed", async () => {
    const s = store([])
    s.list.mockRejectedValue(new Error("no such directory"))

    expect(await sweepCatalogCopyTemps(s, TEMPLATE)).toEqual([])
    expect(s.delete).not.toHaveBeenCalled()
  })
})
