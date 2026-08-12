<template>
  <div class="footer">
    <!-- Once subscribed there's nothing to buy: show Manage, not the plans. -->
    <SubscriptionManageButton v-if="isSubscribed" @manage="emit('manage')" />

    <template v-else>
      <SubscriptionPlans
        :packages="packages"
        :ready="ready"
        :reconciling="reconciling"
        :purchasing="purchasing"
        @subscribe="emit('subscribe', $event)"
        @update:has-trial="hasTrial = $event"
      />
      <SubscriptionDisclaimer v-if="resolved && packages.length > 0" :has-trial="hasTrial" />
    </template>

    <SubscriptionLinks
      :legal-documents="legalDocuments"
      :restoring="restoring"
      :show-restore="isSubscribed || packages.length > 0"
      @restore="emit('restore')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import SubscriptionPlans from "./SubscriptionPlans.vue"
import SubscriptionManageButton from "./SubscriptionManageButton.vue"
import SubscriptionDisclaimer from "./SubscriptionDisclaimer.vue"
import SubscriptionLinks from "./SubscriptionLinks.vue"
import type { PackageView, LegalDocumentView } from "./types.js"

/**
 * The Settings subscription footer: composes the reusable purchase block
 * (SubscriptionPlans) with the trial disclaimer and the Restore/legal row.
 * The onboarding paywall composes SubscriptionPlans directly with its own
 * inline links instead of using this full footer.
 */
const props = defineProps<{
  packages: PackageView[]
  isSubscribed: boolean
  ready: boolean
  /** See SubscriptionPlans — required here so a host cannot forget it. */
  reconciling: boolean
  purchasing: boolean
  restoring: boolean
  legalDocuments: LegalDocumentView[]
}>()

const resolved = computed(() => props.ready && !props.reconciling)

const emit = defineEmits<{
  subscribe: [packageId: string]
  restore: []
  manage: []
}>()

const hasTrial = ref(false)
</script>

<style scoped>
.footer {
  background: var(--ion-background-color);
}
</style>
