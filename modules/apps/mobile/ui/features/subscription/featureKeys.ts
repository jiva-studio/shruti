export type SubscriptionFeatureKey =
  | "newLectures"
  | "bookmarks"
  | "smartLibrary"
  | "chat"
  | "autoScroll"
  | "notesStudio"

export interface FeatureSlideDef {
  readonly key: SubscriptionFeatureKey
  readonly i18nKey: string
  readonly soon: boolean
}

export const FEATURE_SLIDES: readonly FeatureSlideDef[] = [
  { key: "newLectures", i18nKey: "benefit0", soon: false },
  { key: "chat", i18nKey: "chat", soon: false },
  { key: "bookmarks", i18nKey: "benefit1", soon: false },
  { key: "smartLibrary", i18nKey: "benefit2", soon: false },
  { key: "autoScroll", i18nKey: "autoScroll", soon: false },
  { key: "notesStudio", i18nKey: "notesStudio", soon: false },
] as const

export function slideIndexForFeature(feature: string | undefined): number {
  if (!feature) return 0
  const i = FEATURE_SLIDES.findIndex((s) => s.key === feature)
  return i < 0 ? 0 : i
}
