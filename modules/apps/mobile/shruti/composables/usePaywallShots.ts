import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import type { ShotView } from "@ui/features/subscription/index.js"

/** One slide of the paywall screenshot strip. `img` is the asset name under
 *  `/onboarding/<lang>/<img>.webp`; `benefit` is the key under
 *  `settings.subscription.benefits.*` for the caption + description. The same
 *  list (and order) drives both the onboarding paywall and the Settings
 *  subscription page so the two carousels stay identical. */
interface PaywallSlideDef {
  readonly key: string
  readonly img: string
  readonly benefit: string
}

const PAYWALL_SLIDES: readonly PaywallSlideDef[] = [
  { key: "chat", img: "chat", benefit: "sakha" },
  { key: "newLectures", img: "library", benefit: "benefit0" },
  { key: "autoScroll", img: "transcript", benefit: "autoScroll" },
  { key: "bookmarks", img: "notes", benefit: "benefit1" },
  { key: "progress", img: "home", benefit: "progress" },
  { key: "smartLibrary", img: "smartLibrary", benefit: "benefit2" },
  { key: "more", img: "more", benefit: "andMore" },
] as const

// `?feature=` deep links (a locked Settings row → its slide). The features
// folded into "and much more" all land on that slide.
const FEATURE_TO_SLIDE: Record<string, string> = {
  newLectures: "newLectures",
  chat: "chat",
  bookmarks: "bookmarks",
  smartLibrary: "smartLibrary",
  autoScroll: "autoScroll",
  continuousPlayback: "more",
  trackInfo: "more",
  shareTranscript: "more",
  notesStudio: "more",
}

export function slideKeyForFeature(feature: string | undefined): string | undefined {
  return feature ? FEATURE_TO_SLIDE[feature] : undefined
}

/** The paywall screenshot strip, localised. Screenshots exist in en + ru;
 *  every other UI locale falls back to the en asset. */
export function usePaywallShots(): ComputedRef<ShotView[]> {
  const { t } = useI18n()
  const appLanguage = useAppLanguage()
  const shotLang = computed(() => (appLanguage.value === "ru" ? "ru" : "en"))

  return computed(() =>
    PAYWALL_SLIDES.map((s) => ({
      key: s.key,
      label: t(`settings.subscription.benefits.${s.benefit}.title`),
      desc: t(`settings.subscription.benefits.${s.benefit}.description`),
      src: `/onboarding/${shotLang.value}/${s.img}.webp`,
    }))
  )
}
