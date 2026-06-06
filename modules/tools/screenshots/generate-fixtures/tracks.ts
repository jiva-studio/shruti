/**
 * Curated demo track IDs. Each list's first element is the transcript
 * demo for scenario `04_transcript`; the rest fill the home playlist
 * shown in scenarios `01_home` and ripple through the heatmap.
 *
 * Picked from the published catalog (`resources/lake-out/artifacts/
 * catalog/current.db`) — confirmed to have audio + transcript in the
 * target locale.
 */
// Six tracks (in parity with the RU list) so the Home playlist fits the
// viewport with the two newest, still-unfinished rows visible above the
// floating player rather than pushed below the fold.
export const PLAYLIST_TRACKS_EN: readonly string[] = [
  "track_0M6TgFqYKo01", // transcript demo: "Caitanya Mahaprabhu and the Sankirtan Movement"
  "track_0aDNopWvLFpq", // "Kirtana and Prayers of Love"
  "track_0CeTlz6QFX6b", // "Deliverance from the Miserable Condition of Hellish Life"
  "track_0JkscmDgrJ2A", // "Yoga as Linking with the Supreme Lord"
  "track_0dRAV1Swc3ak", // "Prahlāda Mahārāja's Instruction to His Classmates"
  "track_6WmfTZDnwivk", // "Lord Chaitanya's Six Opulences"
]

export const PLAYLIST_TRACKS_RU: readonly string[] = [
  "track_95Z39JrFM1MQ", // transcript demo: "Когда Господь улыбается"
  "track_k1a4Ah1CZ8ac", // "Аромат души"
  "track_7OILnakrziEB", // "Душа всегда остается личностью"
  "track_NHsgDTYRJf6J", // "Мы можем участвовать в наслаждении Бога"
  "track_F79Jy9lTKByn", // "Люди потеряли разум"
  "track_G3M4xu0yncJN", // "Ратха-Ятра"
]

export function playlistTracksFor(locale: string): readonly string[] {
  return locale === "ru" ? PLAYLIST_TRACKS_RU : PLAYLIST_TRACKS_EN
}

export function demoTranscriptTrackId(locale: string): string {
  return playlistTracksFor(locale)[0]!
}
