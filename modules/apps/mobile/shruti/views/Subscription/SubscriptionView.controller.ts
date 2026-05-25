import { computed, ref, watch, type ComputedRef, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import router from "@shruti/router/index.js"
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
  // Use the singleton router's reactive `currentRoute` instead of
  // `useRoute()`. The vue-router `inject('route location')` symbol can
  // be unresolved at setup() for this page — IonRouterOutlet instantiates
  // it during the navigation that triggered the push, before the provide
  // chain is wired in this component's context — so `useRoute()` returns
  // `undefined` and accessing `.query` throws. Same workaround as App.vue.
  const currentRoute = router.currentRoute
  const { t } = useI18n()
  const subscription = useSubscriptionBinding()

  const featureFromRoute = (): string | undefined => {
    const f = currentRoute.value?.query?.feature
    return typeof f === "string" ? f : undefined
  }

  const initialIndex = slideIndexForFeature(featureFromRoute())
  const index = ref<number>(initialIndex)

  watch(
    () => currentRoute.value?.query?.feature,
    (next) => {
      if (typeof next !== "string") return
      index.value = slideIndexForFeature(next)
    }
  )

  const slides = computed<SlideView[]>(() =>
    FEATURE_SLIDES.map((s: FeatureSlideDef) => ({
      key: s.key,
      icon: s.icon,
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
