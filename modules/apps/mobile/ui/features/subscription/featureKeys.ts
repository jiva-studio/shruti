export type SubscriptionFeatureKey =
  | "newLectures"
  | "bookmarks"
  | "smartLibrary"
  | "chat"
  | "autoScroll"
  | "continuousPlayback"
  | "trackInfo"
  | "notesStudio"

export interface FeatureSlideDef {
  readonly key: SubscriptionFeatureKey
  readonly i18nKey: string
  readonly icon: string
  readonly soon: boolean
}

export const FEATURE_SLIDES: readonly FeatureSlideDef[] = [
  { key: "newLectures", i18nKey: "benefit0", icon: "/subscription/newLectures.png", soon: false },
  { key: "chat", i18nKey: "sakha", icon: "/subscription/sakha.png", soon: false },
  { key: "bookmarks", i18nKey: "benefit1", icon: "/subscription/bookmarks.png", soon: false },
  { key: "smartLibrary", i18nKey: "benefit2", icon: "/subscription/smartLibrary.png", soon: false },
  { key: "autoScroll", i18nKey: "autoScroll", icon: "/subscription/autoScroll.png", soon: false },
  {
    key: "continuousPlayback",
    i18nKey: "continuousPlayback",
    icon: "/subscription/continuousPlayback.png",
    soon: false,
  },
  { key: "trackInfo", i18nKey: "trackInfo", icon: "/subscription/trackInfo.png", soon: false },
  {
    key: "notesStudio",
    i18nKey: "notesStudio",
    icon: "/subscription/notesStudio.png",
    soon: false,
  },
] as const

export function slideIndexForFeature(feature: string | undefined): number {
  if (!feature) return 0
  const i = FEATURE_SLIDES.findIndex((s) => s.key === feature)
  return i < 0 ? 0 : i
}
