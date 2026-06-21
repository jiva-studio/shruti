<template>
  <div class="footer">
    <template v-if="!isSubscribed && packages.length > 0">
      <IonItem
        v-for="pkg in packages"
        :key="pkg.packageId"
        :color="selectedPackageId === pkg.packageId ? 'primary' : 'light'"
        class="plan"
        lines="none"
        @click="selectedPackageId = pkg.packageId"
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
        :disabled="!selectedPackageId || purchasing"
        @click="onSubscribeClick"
      >
        {{ ctaLabel }}
      </IonButton>

      <IonNote class="trial-disclaimer">
        {{
          selectedHasTrial
            ? $t("settings.subscription.trialDisclaimer")
            : $t("settings.subscription.disclaimer")
        }}
      </IonNote>
    </template>

    <template v-else-if="isSubscribed">
      <IonButton expand="block" class="cta" :strong="true" @click="emit('manage')">
        {{ $t("settings.subscription.manage") }}
      </IonButton>
    </template>

    <!-- No purchase or manage branch applies: the store hasn't resolved its
         first round-trip yet (transient), or this build simply has no IAP
         (RU / web — permanent). Without an explicit branch the footer renders
         blank, so show a loading hint until `ready`, then a plain
         "unavailable here" note. -->
    <IonNote v-else-if="!ready" class="footer-status">
      {{ $t("settings.subscription.loading") }}
    </IonNote>

    <IonNote v-else class="footer-status">
      {{ $t("settings.subscription.unavailable") }}
    </IonNote>

    <IonButton
      v-if="showCantPay"
      expand="block"
      fill="clear"
      color="medium"
      class="cant-pay"
      @click="emit('cantPay')"
    >
      {{ $t("settings.subscription.cantPay") }}
    </IonButton>

    <div class="secondary">
      <RowDivider class="secondary-divider" />
      <div class="secondary-links">
        <a
          v-if="showRestore"
          class="secondary-link"
          role="button"
          tabindex="0"
          :class="{ 'is-busy': restoring }"
          @click="!restoring && emit('restore')"
          @keydown.enter="!restoring && emit('restore')"
        >
          {{ $t("settings.subscription.restore") }}
        </a>
        <a
          v-for="doc in legalDocuments"
          :key="doc.title"
          class="secondary-link"
          :href="doc.link"
          target="_blank"
        >
          {{ doc.title }}
        </a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonIcon, IonItem, IonLabel, IonNote } from "@ionic/vue"
import { IconStarFilled } from "@tabler/icons-vue"
import { checkmarkCircle } from "ionicons/icons"
import RowDivider from "@ui/components/RowDivider.vue"

export interface IntroOfferView {
  isFree: boolean
  priceString: string
  periodUnit: string
  periodNumberOfUnits: number
}

export interface PackageView {
  packageId: string
  priceString: string
  billingPeriod: string
  introOffer?: IntroOfferView
}

export interface LegalDocumentView {
  title: string
  link: string
}

const props = defineProps<{
  packages: PackageView[]
  isSubscribed: boolean
  /**
   * `true` once the purchases store finished its first round-trip (or
   * determined the build has no IAP). Gates the loading vs. "unavailable
   * here" fallback shown when there are no packages and no subscription.
   */
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

const { t, te } = useI18n()
const selectedPackageId = ref<string | undefined>(undefined)

const showRestore = computed<boolean>(() => props.isSubscribed || props.packages.length > 0)

watch(
  () => props.packages,
  (next) => {
    if (selectedPackageId.value) return
    if (next.length === 0) return
    selectedPackageId.value = next[0]?.packageId
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

const ctaLabel = computed<string>(() =>
  selectedHasTrial.value
    ? t("settings.subscription.startFreeTrial")
    : t("settings.subscription.subscribe")
)

function onSubscribeClick(): void {
  if (!selectedPackageId.value) return
  emit("subscribe", selectedPackageId.value)
}
</script>

<style scoped>
.footer {
  padding: 4px 0 8px;
  background: var(--ion-background-color);
}

.plan {
  margin: 0 16px 8px;
  border-radius: 12px;
  --border-radius: 12px;
  --min-height: 56px;
  --padding-top: 6px;
  --padding-bottom: 6px;
  cursor: pointer;
}

.plan-icon {
  margin-inline-end: 12px;
  color: var(--ion-color-warning);
}

.cta {
  margin: 12px 16px 4px;
  --box-shadow: none;
  --border-radius: 12px;
}

.plan h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1rem;
}

.plan p {
  margin: 2px 0 0;
  font-size: 0.88rem;
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

.trial-disclaimer {
  display: block;
  max-width: 320px;
  margin: 14px auto 4px;
  font-size: 0.78rem;
  line-height: 1.45;
  color: var(--ion-color-medium);
  text-align: center;
}

.cant-pay {
  margin: 0 16px;
  --box-shadow: none;
  font-size: 0.9rem;
}

.footer-status {
  display: block;
  margin: 12px 16px;
  font-size: 0.9rem;
  line-height: 1.3;
  color: var(--ion-color-medium);
  text-align: center;
}

.secondary {
  margin-top: 28px;
}

.secondary-divider {
  margin: 0 16px 14px;
}

.secondary-links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 0 16px 12px;
}

.secondary-link {
  color: var(--ion-color-medium);
  text-decoration: none;
  font-size: 0.9rem;
  cursor: pointer;
}

.secondary-link.is-busy {
  opacity: 0.5;
  pointer-events: none;
}
</style>
