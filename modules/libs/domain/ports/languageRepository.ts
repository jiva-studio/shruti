import type { LanguageCode } from "../core.js"
import type { Language } from "../language.js"

export interface ILanguageRepository {
  getByCode(code: LanguageCode): Promise<Language | null>
  listAll(): Promise<readonly Language[]>
  /** Languages that have at least one non-hidden track. Used by the search
   *  language filter so empty languages are not offered. */
  listWithTracks(): Promise<readonly Language[]>
}
