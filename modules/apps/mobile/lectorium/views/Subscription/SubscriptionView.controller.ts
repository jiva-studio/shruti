import { ref, watch, type ComputedRef, type Ref } from "vue"
import router from "@lectorium/router/index.js"
import { usePaywallShots, slideKeyForFeature } from "@lectorium/composables/usePaywallShots.js"
import type { ShotView } from "@ui/features/subscription/index.js"
import {
  useSubscriptionBinding,
  type SubscriptionBinding,
} from "@lectorium/views/Settings/composables/useSubscriptionBinding.js"

export interface SubscriptionViewBinding {
  readonly subscription: SubscriptionBinding
  readonly shots: ComputedRef<ShotView[]>
  readonly initialKey: Ref<string | undefined>
}

export function useSubscriptionViewController(): SubscriptionViewBinding {
  // Use the singleton router's reactive `currentRoute` instead of
  // `useRoute()`. The vue-router `inject('route location')` symbol can
  // be unresolved at setup() for this page — IonRouterOutlet instantiates
  // it during the navigation that triggered the push, before the provide
  // chain is wired in this component's context — so `useRoute()` returns
  // `undefined` and accessing `.query` throws. Same workaround as App.vue.
  const currentRoute = router.currentRoute
  const subscription = useSubscriptionBinding()
  const shots = usePaywallShots()

  const featureFromRoute = (): string | undefined => {
    const f = currentRoute.value?.query?.feature
    return typeof f === "string" ? f : undefined
  }

  const initialKey = ref<string | undefined>(slideKeyForFeature(featureFromRoute()))

  watch(
    () => currentRoute.value?.query?.feature,
    (next) => {
      if (typeof next !== "string") return
      initialKey.value = slideKeyForFeature(next)
    }
  )

  return { subscription, shots, initialKey }
}
