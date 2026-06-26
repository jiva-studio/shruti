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
  /** Catalog `sources.id` for an in-library scripture; the UI looks up the
   *  localised name. Exactly one of `sourceId` / `sourceName` is present. */
  readonly sourceId?: SourceId
  /** Verbatim name of an external work not in the catalog (e.g. an Upaniṣad).
   *  Rendered as-is when there is no `sourceId`. */
  readonly sourceName?: string
  readonly tokens: readonly string[]
}
