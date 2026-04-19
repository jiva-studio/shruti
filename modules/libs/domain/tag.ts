import type { LanguageCode, TagId } from "./core.js"

export interface Tag {
  readonly id: TagId
  readonly names: ReadonlyMap<LanguageCode, string>
}
