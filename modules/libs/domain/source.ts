import type { LanguageCode, SourceId } from "./core.js"

export interface SourceName {
  readonly fullName: string
  readonly shortName: string
}

export interface Source {
  readonly id: SourceId
  /** Localized full/short names, keyed by language code. */
  readonly names: ReadonlyMap<LanguageCode, SourceName>
}
