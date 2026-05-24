import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useRoute } from "vue-router"
import { useI18n } from "vue-i18n"
import {
  FEATURE_SLIDES,
  slideIndexForFeature,
  type FeatureSlideDef,
} from "@ui/features/subscription/index.js"
import {
  useSubscriptionBinding,
  type SubscriptionBinding,
} from "@shruti/views/Settings/composables/useSubscriptionBinding.js"

export interface SlideView {
  readonly key: string
  readonly icon: string
  readonly title: string
  readonly description: string
  readonly soon: boolean
}

export interface SubscriptionViewBinding {
  readonly subscription: SubscriptionBinding
  readonly slides: ComputedRef<SlideView[]>
  readonly initialIndex: number
  readonly index: Ref<number>
  setIndex: (i: number) => void
}

export function useSubscriptionViewController(): SubscriptionViewBinding {
  const route = useRoute()
  const { t } = useI18n()
  const subscription = useSubscriptionBinding()

  const initialIndex = slideIndexForFeature(
    typeof route.query.feature === "string" ? route.query.feature : undefined
  )
  const index = ref<number>(initialIndex)

  watch(
    () => route.query.feature,
    (next) => {
      if (typeof next !== "string") return
      index.value = slideIndexForFeature(next)
    }
  )

  const slides = computed<SlideView[]>(() =>
    FEATURE_SLIDES.map((s: FeatureSlideDef) => ({
      key: s.key,
      icon: t(`settings.subscription.benefits.${s.i18nKey}.icon`),
      title: t(`settings.subscription.benefits.${s.i18nKey}.title`),
      description: t(`settings.subscription.benefits.${s.i18nKey}.description`),
      soon: s.soon,
    }))
  )

  return {
    subscription,
    slides,
    initialIndex,
    index,
    setIndex: (i: number) => {
      index.value = i
    },
  }
}
