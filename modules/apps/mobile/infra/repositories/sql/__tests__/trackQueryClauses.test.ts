import { describe, expect, it } from "vitest"
import type { AuthorId, LanguageCode, TagId } from "@lib/domain/core.js"
import { buildFilterClauses, sortOrderClause } from "../trackQueryClauses.js"

describe("buildFilterClauses", () => {
  it("has nothing to say about an empty filter", () => {
    expect(buildFilterClauses({})).toEqual({ clauses: [], params: [] })
  })

  it("narrows a column on tracks for an author", () => {
    const { clauses, params } = buildFilterClauses({
      authorIds: ["a1", "a2"] as AuthorId[],
    })
    expect(clauses).toEqual(["t.author_id IN (?, ?)"])
    expect(params).toEqual(["a1", "a2"])
  })

  it("narrows through the join table for a tag", () => {
    const { clauses, params } = buildFilterClauses({ tagIds: ["t1"] as TagId[] })
    expect(clauses).toEqual(["t.id IN (SELECT track_id FROM track_tags WHERE tag_id IN (?))"])
    expect(params).toEqual(["t1"])
  })

  it("ignores an id filter that is present but empty", () => {
    expect(buildFilterClauses({ authorIds: [], tagIds: [] }).clauses).toEqual([])
  })

  it("emits the duration bounds inclusive-exclusive", () => {
    const { clauses, params } = buildFilterClauses({ durationMinMs: 1000, durationMaxMs: 2000 })
    expect(clauses[0]).toMatch(/>= \?$/)
    expect(clauses[1]).toMatch(/< \?$/)
    expect(params).toEqual([1000, 2000])
  })

  it("keeps a zero duration bound, which is not the same as absent", () => {
    expect(buildFilterClauses({ durationMinMs: 0 }).params).toEqual([0])
  })

  it("compares the date bounds as strings", () => {
    const { clauses, params } = buildFilterClauses({ dateGte: "1974-01-01", dateLt: "1975-01-01" })
    expect(clauses).toEqual(["t.date >= ?", "t.date < ?"])
    expect(params).toEqual(["1974-01-01", "1975-01-01"])
  })

  it("keeps clauses and params in the same order across filter kinds", () => {
    const { clauses, params } = buildFilterClauses({
      authorIds: ["a1"] as AuthorId[],
      languageCodes: ["ru"] as LanguageCode[],
      dateGte: "1974-01-01",
    })
    expect(clauses).toHaveLength(3)
    expect(params).toEqual(["a1", "ru", "1974-01-01"])
  })
})

describe("sortOrderClause", () => {
  it("sorts by reference first, then date", () => {
    const { clause, params } = sortOrderClause("byReference", "ru" as LanguageCode)
    expect(clause).toMatch(/^ORDER BY \(\s*\n?\s*SELECT v\.sort_reference/)
    expect(clause).toContain("t.date DESC NULLS LAST")
    expect(params).toEqual(["ru"])
  })

  it("sorts by date ascending", () => {
    expect(sortOrderClause("byDateAsc", "en" as LanguageCode).clause).toMatch(
      /^ORDER BY t\.date ASC NULLS LAST/
    )
  })

  it("falls back to newest first when no sort was asked for", () => {
    const fallback = sortOrderClause(undefined, "en" as LanguageCode)
    expect(fallback).toEqual(sortOrderClause("byDateDesc", "en" as LanguageCode))
  })

  it("takes one language parameter whichever sort is picked", () => {
    expect(sortOrderClause("byReference", "ru" as LanguageCode).params).toEqual(["ru"])
    expect(sortOrderClause("byDateAsc", "ru" as LanguageCode).params).toEqual(["ru"])
  })
})
