import type { LanguageCode, LocationId } from "./core.js"

export interface Location {
  readonly id: LocationId
  readonly names: ReadonlyMap<LanguageCode, string>
}
