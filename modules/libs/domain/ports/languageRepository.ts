import type { LanguageCode } from "../core.js"
import type { Language } from "../language.js"

export interface ILanguageRepository {
  getByCode(code: LanguageCode): Promise<Language | null>
  listAll(): Promise<readonly Language[]>
}
