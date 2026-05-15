<template>
  <IonModal :is-open="open" class="subscription-modal" @did-dismiss="open = false">
    <IonHeader>
      <IonToolbar>
        <IonTitle>{{ $t("settings.subscription.title") }}</IonTitle>
        <IonButtons slot="end">
          <IonButton shape="round" size="small" @click="open = false">
            {{ $t("app.close") }}
          </IonButton>
        </IonButtons>
      </IonToolbar>
    </IonHeader>

    <IonContent>
      <div class="header">
        <h2>{{ $t("settings.subscription.choose") }}</h2>
        <p>{{ $t("settings.subscription.benefits.intro") }}</p>
      </div>

      <div v-for="benefit in benefits" :key="benefit.key" class="benefit-wrap">
        <IonItem class="benefit" lines="none">
          <div slot="start" class="benefit-icon">
            {{ $t(`settings.subscription.benefits.${benefit.key}.icon`) }}
          </div>
          <IonLabel>
            <h2>{{ $t(`settings.subscription.benefits.${benefit.key}.title`) }}</h2>
            <p>{{ $t(`settings.subscription.benefits.${benefit.key}.description`) }}</p>
          </IonLabel>
        </IonItem>
        <div v-if="benefit.soon" class="benefit-tag">{{ $t("app.soon") }}</div>
      </div>

      <template v-if="!isSubscribed && packages.length > 0">
        <IonItem
          v-for="pkg in packages"
          :key="pkg.packageId"
          :color="selectedPackageId === pkg.packageId ? 'primary' : 'light'"
          class="plan"
          lines="none"
          @click="selectedPackageId = pkg.packageId"
        >
          <div slot="start">⭐️</div>
          <IonLabel>
            <h2>
              <b>{{ planTitle(pkg.packageId) }}</b>
            </h2>
            <p>{{ pkg.priceString }} / {{ periodLabel(pkg.billingPeriod) }}</p>
          </IonLabel>
          <IonIcon v-if="selectedPackageId === pkg.packageId" slot="end" :icon="checkmarkCircle" />
        </IonItem>

        <IonButton
          expand="block"
          class="subscribe"
          :strong="true"
          :disabled="!selectedPackageId || purchasing"
          @click="onSubscribeClick"
        >
          {{ $t("settings.subscription.subscribe") }}
        </IonButton>

        <IonButton expand="block" fill="clear" :disabled="restoring" @click="emit('restore')">
          {{ $t("settings.subscription.restore") }}
        </IonButton>
      </template>

      <IonNote class="legal">
        <a v-for="doc in legalDocuments" :key="doc.title" :href="doc.link" target="_blank">
          {{ doc.title }}
        </a>
      </IonNote>

      <pre v-if="debugLog && debugLog.length > 0" class="debug-log">{{ debugLog.join("\n") }}</pre>
    </IonContent>
  </IonModal>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { checkmarkCircle } from "ionicons/icons"

export interface SubscriptionPlanView {
  packageId: string
  productId: string
  title: string
  description: string
  priceString: string
  billingPeriod: string
}

export interface LegalDocumentView {
  title: string
  link: string
}

const props = defineProps<{
  packages: SubscriptionPlanView[]
  isSubscribed: boolean
  purchasing: boolean
  restoring: boolean
  legalDocuments: LegalDocumentView[]
  debugLog?: string[]
}>()

const emit = defineEmits<{
  subscribe: [packageId: string]
  restore: []
}>()

const open = defineModel<boolean>("open", { required: true })

const { t, te } = useI18n()

// Order matters: it's the order rendered in the paywall. `soon` flips
// the "Soon" tag on for features not yet shipped.
const benefits = [
  { key: "benefit0", soon: false }, // new lectures
  { key: "benefit1", soon: false }, // bookmarks
  { key: "benefit2", soon: true }, // auto-download lectures
  { key: "benefit5", soon: true }, // advanced search
] as const

const selectedPackageId = ref<string | undefined>(undefined)

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

function onSubscribeClick(): void {
  if (!selectedPackageId.value) return
  emit("subscribe", selectedPackageId.value)
}
</script>

<style scoped>
.header {
  text-align: center;
  padding: 1.5rem 1rem 0.5rem;
}

.benefit-wrap {
  position: relative;
}

.benefit {
  margin: 0 1rem 0.5rem;
  border-radius: 8px;
  --background: var(--ion-color-step-50, var(--ion-color-light));
}

.benefit-icon {
  font-size: 1.25rem;
}

.benefit-tag {
  position: absolute;
  border-radius: 5px;
  padding: 0.3rem;
  transform: rotate(-15deg);
  top: 3px;
  right: 4px;
  background-color: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  font-size: 0.55rem;
  /* IonItem opens its own stacking context; without z-index the tag
     ends up behind the row. */
  z-index: 2;
  pointer-events: none;
}

.plan {
  margin: 0 1rem 0.5rem;
  border-radius: 8px;
  cursor: pointer;
}

.subscribe {
  margin: 1.5rem 1rem 0.25rem;
  /* Material flavour adds a drop-shadow / elevation by default; we
     keep dialog surfaces flat across the app. */
  --box-shadow: none;
}

.legal {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-evenly;
  gap: 0.5rem;
  padding: 1rem;
}

.legal a {
  color: var(--ion-color-medium);
  text-decoration: none;
  font-size: 0.9rem;
}

/* Temporary diagnostic block — see usePurchasesStore.debugLog. */
.debug-log {
  margin: 1rem;
  padding: 0.75rem;
  border-radius: 6px;
  background: rgba(127, 127, 127, 0.15);
  color: var(--ion-color-medium);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.7rem;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-x: auto;
}
</style>

<style>
/* IonModal renders into a teleport portal, so scoped styles can't
   reach the sheet itself. Kill Material's drop-shadow on the modal
   frame AND the elevation strip Material paints under the header. */
.subscription-modal {
  --box-shadow: none;
}
.subscription-modal ion-header::after {
  display: none;
  background-image: none;
}
</style>
