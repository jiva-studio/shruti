import type { AuthorId, LanguageCode } from "./core.js"

export interface Author {
  readonly id: AuthorId
  /** Localized full names, keyed by language code. */
  readonly names: ReadonlyMap<LanguageCode, string>
}
