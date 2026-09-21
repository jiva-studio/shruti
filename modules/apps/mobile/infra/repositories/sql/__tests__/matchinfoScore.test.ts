import { describe, expect, it } from "vitest"
import type { TrackId } from "@lib/domain/core.js"
import { rankSearchRows, type ScoredSearchRow } from "../matchinfoScore.js"

/** matchinfo('pcx') for p=1, c=1: header plus one (hits, corpus hits, rows) triple. */
function pcx(hitsInRow: number, rowsWithTerm: number): Uint8Array {
  return new Uint8Array(new Uint32Array([1, 1, hitsInRow, hitsInRow, rowsWithTerm]).buffer)
}

function row(id: string, date: string | null, __minfo: Uint8Array | null): ScoredSearchRow {
  return { id: id as TrackId, date, __minfo }
}

describe("rankSearchRows", () => {
  it("puts the more relevant row first", () => {
    const ranked = rankSearchRows(
      [row("low", "1974-01-01", pcx(1, 50)), row("high", "1974-01-01", pcx(9, 2))],
      1000
    )
    expect(ranked).toEqual(["high", "low"])
  })

  it("breaks a tie on score by the newer date", () => {
    const ranked = rankSearchRows(
      [row("older", "1974-01-01", pcx(3, 5)), row("newer", "1980-06-01", pcx(3, 5))],
      1000
    )
    expect(ranked).toEqual(["newer", "older"])
  })

  it("sorts a row without a date after a dated one", () => {
    const ranked = rankSearchRows(
      [row("undated", null, pcx(3, 5)), row("dated", "1974-01-01", pcx(3, 5))],
      1000
    )
    expect(ranked).toEqual(["dated", "undated"])
  })

  it("breaks a tie on score and date by id, so paging is stable", () => {
    const ranked = rankSearchRows(
      [row("b", "1974-01-01", pcx(3, 5)), row("a", "1974-01-01", pcx(3, 5))],
      1000
    )
    expect(ranked).toEqual(["a", "b"])
  })

  it("still returns a row whose blob is unusable, unranked", () => {
    const ranked = rankSearchRows(
      [row("scored", "1974-01-01", pcx(3, 5)), row("blobless", "1999-01-01", null)],
      1000
    )
    expect(ranked).toEqual(["scored", "blobless"])
  })

  it("has nothing to rank for no rows", () => {
    expect(rankSearchRows([], 1000)).toEqual([])
  })
})
