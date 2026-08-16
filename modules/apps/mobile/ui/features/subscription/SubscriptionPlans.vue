<template>
  <div class="plans">
    <!-- The purchase block: plan cards + the Subscribe CTA. Whoever can't buy
         (an existing subscriber) is handled by the host, which shows a Manage
         button instead of mounting this.

         The cards render as soon as there are packages, and go INERT — not
         absent — while the subscribed answer is still ON ITS WAY. Replacing
         them with a bare note (what #1797 left behind) reads as "there is
         nothing to buy here", which is the one answer we know is wrong; a
         disabled block plus the loading note says "not yet" instead (#1838).

         "Not yet" only holds while an answer is still coming. Once the
         reconcile gives up, the wait has no end and the cards operate on the
         unknown state — they are the offering, not the entitlement — with a
         note pointing an unrecognized subscriber at Restore (#1892). -->
    <template v-if="packages.length > 0">
      <IonItem
        v-for="pkg in packages"
        :key="pkg.packageId"
        :color="selectedPackageId === pkg.packageId ? 'primary' : 'light'"
        :disabled="!isSettled"
        class="plan"
        lines="none"
        @click="onSelect(pkg.packageId)"
      >
        <IconStarFilled slot="start" :size="20" class="plan-icon" />
        <IonLabel>
          <h2>
            <b>{{ planTitle(pkg.packageId) }}</b>
            <span v-if="freeTrial(pkg)" class="trial-badge">{{ trialBadge(pkg) }}</span>
          </h2>
          <p v-if="freeTrial(pkg)">{{ thenPrice(pkg) }}</p>
          <p v-else>{{ pkg.priceString }} / {{ periodLabel(pkg.billingPeriod) }}</p>
        </IonLabel>
        <IonIcon v-if="selectedPackageId === pkg.packageId" slot="end" :icon="checkmarkCircle" />
      </IonItem>

      <IonButton
        expand="block"
        class="cta"
        :strong="true"
        :disabled="!isSettled || !selectedPackageId || purchasing"
        @click="onSubscribeClick"
      >
        {{ ctaLabel }}
      </IonButton>

      <!-- Says why the block above is inert. -->
      <IonNote v-if="!isSettled" class="footer-status">
        {{ $t("settings.subscription.loading") }}
      </IonNote>
      <!-- Operable, but we never learned whether this person already pays —
           so the block must not read as "you are not subscribed". -->
      <IonNote v-else-if="!isResolved" class="footer-status">
        {{ $t("settings.subscription.unconfirmed") }}
      </IonNote>
    </template>

    <!-- Nothing to render cards from: either the packages haven't arrived yet
         (transient) or this build simply has no IAP (RU / web — permanent).
         Show a loading hint until `ready`, then a plain "unavailable here"
         note, so the block never renders blank. -->
    <IonNote v-else-if="!ready" class="footer-status">
      {{ $t("settings.subscription.loading") }}
    </IonNote>
    <IonNote v-else class="footer-status">
      {{ $t("settings.subscription.unavailable") }}
    </IonNote>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonIcon, IonItem, IonLabel, IonNote } from "@ionic/vue"
import { IconStarFilled } from "@tabler/icons-vue"
import { checkmarkCircle } from "ionicons/icons"
import type { IntroOfferView, PackageView } from "./types.js"

const props = defineProps<{
  packages: PackageView[]
  /**
   * `true` once the purchases store finished its first round-trip (or
   * determined the build has no IAP). Gates the loading vs. "unavailable
   * here" fallback shown when there are no packages.
   */
  ready: boolean
  /**
   * `true` once the store's subscribed answer is FINAL. `ready` alone does
   * not mean the store knows whether this user is subscribed — an
   * account-tied entitlement only surfaces once the identity round-trip
   * lands (#1797) — so while that is still coming the block stays inert, and
   * when it never came the block says so. Optional: hosts with no identity
   * transition to wait on (the onboarding paywall) leave it unset and get
   * `ready`.
   */
  resolved?: boolean
  /**
   * `true` once no better answer is coming — the identity round-trip either
   * landed (then `resolved` too) or blew its budget. This, not `resolved`, is
   * what the purchase block operates on: the cards are the offering, so an
   * entitlement we never learned is no reason to refuse the sale, and gating
   * them on `resolved` disabled the paywall for exactly the user `ensurePro`
   * had just routed to it (#1892). Optional: hosts that don't distinguish the
   * two leave it unset and get `resolved`.
   */
  settled?: boolean
  purchasing: boolean
}>()

/** The subscribed answer is final. */
const isResolved = computed(() => props.resolved ?? props.ready)

/** The purchase block may be operated. */
const isSettled = computed(() => props.settled ?? isResolved.value)

const emit = defineEmits<{
  subscribe: [packageId: string]
  /** Whether the currently-selected plan carries a free trial — the host
   *  feeds this to a SubscriptionDisclaimer when it composes one. */
  "update:hasTrial": [hasTrial: boolean]
}>()

const { t, te } = useI18n()
const selectedPackageId = ref<string | undefined>(undefined)

watch(
  () => props.packages,
  (next) => {
    if (selectedPackageId.value) return
    if (next.length === 0) return
    // Default to the plan that carries a free trial (typically the annual),
    // falling back to the first package.
    const withTrial = next.find((p) => p.introOffer?.isFree)
    selectedPackageId.value = (withTrial ?? next[0])?.packageId
  },
  { immediate: true }
)

function planTitle(packageId: string): string {
  const key = `settings.subscription.plans.${packageId}`
  return te(key) ? t(key) : packageId
}

function periodLabel(period: string): string {
  if (!period) return ""
  const key = `settings.subscription.periods.${period}`
  return te(key) ? t(key) : period
}

/** The free trial on a package, if it carries one we should advertise. */
function freeTrial(pkg: PackageView): IntroOfferView | undefined {
  return pkg.introOffer?.isFree ? pkg.introOffer : undefined
}

/** Normalize the intro period to whole days so iOS's "2 weeks" and
 *  Android's "14 days" both read as the same "14 days free". */
function trialDays(offer: IntroOfferView): number {
  const n = offer.periodNumberOfUnits
  switch (offer.periodUnit) {
    case "WEEK":
      return n * 7
    case "MONTH":
      return n * 30
    case "YEAR":
      return n * 365
    default:
      return n
  }
}

function trialBadge(pkg: PackageView): string {
  const offer = freeTrial(pkg)
  if (!offer) return ""
  return t("settings.subscription.trialBadge", { days: trialDays(offer) })
}

function thenPrice(pkg: PackageView): string {
  return t("settings.subscription.trialThenPrice", {
    price: pkg.priceString,
    period: periodLabel(pkg.billingPeriod),
  })
}

const selectedHasTrial = computed<boolean>(() => {
  const pkg = props.packages.find((p) => p.packageId === selectedPackageId.value)
  return pkg ? freeTrial(pkg) !== undefined : false
})

watch(selectedHasTrial, (v) => emit("update:hasTrial", v), { immediate: true })

const ctaLabel = computed<string>(() =>
  selectedHasTrial.value
    ? t("settings.subscription.startFreeTrial")
    : t("settings.subscription.subscribe")
)

function onSelect(packageId: string): void {
  if (!isSettled.value) return
  selectedPackageId.value = packageId
}

function onSubscribeClick(): void {
  if (!isSettled.value || !selectedPackageId.value) return
  emit("subscribe", selectedPackageId.value)
}
</script>

<style scoped>
.plans {
  background: var(--ion-background-color);
}
.plan {
  margin: 0 0 6px;
  border-radius: 12px;
  --border-radius: 12px;
  --min-height: 42px;
  --padding-top: 2px;
  --padding-bottom: 2px;
  cursor: pointer;
}
.plan-icon {
  margin-inline-end: 10px;
  color: var(--ion-color-warning);
}
.cta {
  margin: 8px 0 0;
  --box-shadow: none;
  --border-radius: 12px;
}
.plan h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 0.95rem;
}
.plan p {
  margin: 1px 0 0;
  font-size: 0.8rem;
}
.trial-badge {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.4;
  background: var(--ion-color-success, #2dd36f);
  color: var(--ion-color-success-contrast, #fff);
}
.footer-status {
  display: block;
  margin: 12px 0;
  font-size: 0.9rem;
  line-height: 1.3;
  color: var(--ion-color-medium);
  text-align: center;
}
</style>
