import type { SourceId } from "./core.js"

/**
 * A scripture reference: `{ sourceId: "source_dsicuBsFvinZ", tokens: ["18", "66"] }`
 * reads as Bhagavad-gītā 18.66.
 *
 * `sourceId` is the catalog `sources.id` primary key (e.g.
 * `source_dsicuBsFvinZ`), not a short scripture code — UI composers
 * look up localised full/short names via the `sources` dictionary.
 * `tokens` is the numeric tail (chapter / verse / text), kept as an
 * array so we can compare/range-detect without re-parsing.
 */
export interface Reference {
  readonly sourceId: SourceId
  readonly tokens: readonly string[]
}
