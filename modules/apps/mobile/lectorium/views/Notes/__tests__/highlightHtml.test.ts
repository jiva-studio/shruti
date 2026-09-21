import { describe, expect, it } from "vitest"
import { highlightHtml } from "../highlightHtml.js"

describe("highlightHtml", () => {
  it("returns the html untouched for an empty query", () => {
    expect(highlightHtml("<em>text</em>", "")).toBe("<em>text</em>")
  })

  it("expands the mark to the whole word around the match", () => {
    expect(highlightHtml("польза есть", "поль")).toBe("<mark>польза</mark> есть")
  })

  it("matches regardless of case", () => {
    expect(highlightHtml("Bhakti", "bha")).toBe("<mark>Bhakti</mark>")
  })

  it("never injects into a generated tag", () => {
    expect(highlightHtml('<a href="em">text</a>', "em")).toBe('<a href="em">text</a>')
  })

  it("marks inside a tag's text run", () => {
    expect(highlightHtml("<em>bhakti</em>", "bhakti")).toBe("<em><mark>bhakti</mark></em>")
  })

  it("treats the query as literal text, not a pattern", () => {
    expect(highlightHtml("a.b", "a.b")).toBe("<mark>a.b</mark>")
  })
})
