/** How a language is named back to the user in a message. The same token the
 *  chip carries, so the toast refers to the thing that was tapped rather than
 *  introducing a second vocabulary for it. */
export function languageLabel(code: string): string {
  return code.toUpperCase()
}

/** Country-flag emoji for a transcript language code (the corpus languages);
 *  undefined for anything unmapped so the selector shows the code alone rather
 *  than a placeholder. A language isn't a country — this is a best-effort label. */
export function languageFlag(code: string): string | undefined {
  const flags: Record<string, string> = {
    en: "🇬🇧",
    ru: "🇷🇺",
    hi: "🇮🇳",
    es: "🇪🇸",
    fr: "🇫🇷",
    de: "🇩🇪",
    pt: "🇵🇹",
    it: "🇮🇹",
    ja: "🇯🇵",
    nl: "🇳🇱",
    uk: "🇺🇦",
    bn: "🇧🇩",
  }
  return flags[code.toLowerCase()]
}
