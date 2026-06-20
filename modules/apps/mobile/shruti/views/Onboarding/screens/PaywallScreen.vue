<template>
  <div class="ob-paywall">
    <div class="ob-paywall__head">
      <h1 class="ob-paywall__title">{{ $t("onboarding.paywall.title") }}</h1>
      <p class="ob-paywall__subtitle">{{ $t("onboarding.paywall.subtitle") }}</p>
    </div>

    <!-- Real app screenshots show what Pro unlocks. Each hides itself if the
         asset isn't shipped yet, so the strip degrades gracefully. -->
    <div class="ob-paywall__shots">
      <img
        v-for="src in shots"
        v-show="!failed.has(src)"
        :key="src"
        :src="src"
        class="ob-paywall__shot"
        alt=""
        @error="failed.add(src)"
      />
    </div>

    <ul class="ob-paywall__bullets">
      <li>{{ $t("onboarding.paywall.b1") }}</li>
      <li>{{ $t("onboarding.paywall.b2") }}</li>
      <li>{{ $t("onboarding.paywall.b3") }}</li>
    </ul>

    <!-- Reused purchase machinery: plan selection, CTA, trial/intro price,
         restore, legal links — identical to the Settings paywall. -->
    <SubscriptionFooter
      :packages="subscription.packages"
      :is-subscribed="subscription.isSubscribed"
      :ready="subscription.ready"
      :purchasing="subscription.purchasing"
      :restoring="subscription.restoring"
      :legal-documents="subscription.legalDocuments"
      :show-cant-pay="subscription.showCantPay"
      @subscribe="subscription.onSubscribe"
      @restore="subscription.onRestore"
      @manage="subscription.onManage"
      @cant-pay="subscription.onCantPay"
    />
  </div>
</template>

<script setup lang="ts">
import { reactive, watch } from "vue"
import { SubscriptionFooter } from "@ui/features/subscription/index.js"
import { useSubscriptionBinding } from "@shruti/views/Settings/composables/useSubscriptionBinding.js"

const emit = defineEmits<{ (e: "done"): void }>()

const subscription = useSubscriptionBinding()

const shots = ["/onboarding/paywall-1.webp", "/onboarding/paywall-2.webp", "/onboarding/paywall-3.webp"]
const failed = reactive(new Set<string>())

// Once the purchase lands, leave onboarding for Home.
watch(
  () => subscription.isSubscribed,
  (now, was) => {
    if (now && !was) emit("done")
  }
)
</script>

<style scoped>
.ob-paywall {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 8px 16px 24px;
  box-sizing: border-box;
}
.ob-paywall__head {
  text-align: center;
  max-width: 440px;
  margin: 0 auto;
}
.ob-paywall__title {
  margin: 0 0 8px;
  font-size: 1.4rem;
  font-weight: 800;
  color: var(--ion-text-color);
}
.ob-paywall__subtitle {
  margin: 0;
  font-size: 0.92rem;
  line-height: 1.4;
  color: var(--ion-color-medium);
}
.ob-paywall__shots {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  justify-content: center;
  padding: 4px 0;
}
.ob-paywall__shot {
  height: clamp(180px, 30vh, 280px);
  width: auto;
  border-radius: 16px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12);
}
.ob-paywall__bullets {
  margin: 0 auto;
  padding: 0 0 0 1.1em;
  max-width: 440px;
  color: var(--ion-text-color);
  font-size: 0.95rem;
  line-height: 1.7;
}
</style>
