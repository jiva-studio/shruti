import type { LanguageCode } from "./core.js"

export interface Language {
  readonly code: LanguageCode
  readonly fullName: string
  /** Optional emoji/icon identifier (e.g. "🇷🇺"). */
  readonly icon: string | null
}
