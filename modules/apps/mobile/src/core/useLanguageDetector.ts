export type DetectedLang =
  | 'en'
  | 'ru'
  | 'sr-Cyrl'
  | 'sr-Latn'
  | 'hi'
  | 'bn'
  | 'unknown'

export function useLanguageDetector() {
  function detect(text: string): DetectedLang {
    const sample = text.slice(0, 200).toLowerCase()

    const counts = {
      'hi': (sample.match(/[\u0900-\u097F]/g) || []).length,
      'bn': (sample.match(/[\u0980-\u09FF]/g) || []).length,
      'sr-Cyrl': (sample.match(/[ђћљњџ]/g) || []).length,
      'sr-Latn': (sample.match(/[čćžšđ]/g) || []).length,
      'ru': (
        (sample.match(/[ёыэщ]/g) || []).length +                     // Russian-specific
        (sample.match(/[\u0400-\u04FF]/g) || []).length              // Generic Cyrillic
      ),
      'en': (sample.match(/[a-z]/g) || []).length,
    }

    let best: DetectedLang = 'unknown'
    let max = 0
    for (const [lang, count] of Object.entries(counts) as [DetectedLang, number][]) {
      if (count > max) {
        max = count
        best = lang
      }
    }

    return best
  }

  return { detect }
}