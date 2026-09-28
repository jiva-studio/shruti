import type { DailyWisdom } from "@lib/domain/dailyWisdom.js"
import type { LanguageCode, TopicId, TrackId } from "@lib/domain/core.js"
import {
  loadOnboardingTopics,
  type OnboardingTopicOption,
} from "@usecases/onboarding/loadOnboardingTopics.js"
import {
  pickBeginnerLectures,
  pickTopicLectures,
  pickWisdomPreview,
} from "@usecases/onboarding/pickFirstLectures.js"
import { useShruti } from "@shruti/shruti.js"

export interface OnboardingUseCases {
  loadTopics(
    lang: LanguageCode,
    languageCodes: readonly LanguageCode[]
  ): Promise<OnboardingTopicOption[]>
  pickTopicLectures(seeds: readonly TopicId[], languages: LanguageCode[]): Promise<TrackId[]>
  pickBeginnerLectures(languages: LanguageCode[]): Promise<TrackId[]>
  pickWisdomPreview(languages: readonly string[]): Promise<DailyWisdom | null>
}

/** The onboarding use cases, bound to the repositories (resolved per call, so
 *  each throws until the databases are open) and to `Math.random` for the draws. */
export function useOnboardingUseCases(): OnboardingUseCases {
  const app = useShruti()
  return {
    loadTopics: (lang, languageCodes) =>
      loadOnboardingTopics(app.repositories(), lang, languageCodes),
    pickTopicLectures: (seeds, languages) =>
      pickTopicLectures(seeds, languages, Math.random, app.repositories()),
    pickBeginnerLectures: (languages) => pickBeginnerLectures(languages, app.repositories()),
    pickWisdomPreview: (languages) => pickWisdomPreview(languages, Math.random, app.repositories()),
  }
}
