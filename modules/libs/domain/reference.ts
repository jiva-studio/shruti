import type { SourceId } from "./core.js"

/**
 * A scripture reference: `{ sourceId: "bg", tokens: ["10", "5"] }`.
 *
 * `sourceId` is the abbreviated scripture code and matches a `Source`
 * in the content DB, so UI composers can look up localised names via
 * the `sources` dictionary. `tokens` is the numeric tail (chapter /
 * verse / text), kept as an array so we can compare/range-detect
 * without re-parsing.
 */
export interface Reference {
  readonly sourceId: SourceId
  readonly tokens: readonly string[]
}
