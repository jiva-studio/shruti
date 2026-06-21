<template>
  <div class="footer">
    <SubscriptionPlans
      :packages="packages"
      :is-subscribed="isSubscribed"
      :ready="ready"
      :purchasing="purchasing"
      :show-cant-pay="showCantPay"
      @subscribe="emit('subscribe', $event)"
      @manage="emit('manage')"
      @cant-pay="emit('cantPay')"
      @update:has-trial="hasTrial = $event"
    />

    <SubscriptionDisclaimer v-if="!isSubscribed && packages.length > 0" :has-trial="hasTrial" />

    <SubscriptionLinks
      :legal-documents="legalDocuments"
      :restoring="restoring"
      :show-restore="isSubscribed || packages.length > 0"
      @restore="emit('restore')"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue"
import SubscriptionPlans from "./SubscriptionPlans.vue"
import SubscriptionDisclaimer from "./SubscriptionDisclaimer.vue"
import SubscriptionLinks from "./SubscriptionLinks.vue"
import type { PackageView, LegalDocumentView } from "./types.js"

/**
 * The Settings subscription footer: composes the reusable purchase block
 * (SubscriptionPlans) with the trial disclaimer and the Restore/legal row.
 * The onboarding paywall composes SubscriptionPlans directly with its own
 * inline links instead of using this full footer.
 */
defineProps<{
  packages: PackageView[]
  isSubscribed: boolean
  ready: boolean
  purchasing: boolean
  restoring: boolean
  legalDocuments: LegalDocumentView[]
  showCantPay?: boolean
}>()

const emit = defineEmits<{
  subscribe: [packageId: string]
  restore: []
  manage: []
  cantPay: []
}>()

const hasTrial = ref(false)
</script>

<style scoped>
.footer {
  background: var(--ion-background-color);
}
</style>
