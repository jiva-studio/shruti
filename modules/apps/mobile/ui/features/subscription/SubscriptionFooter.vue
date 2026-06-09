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
        class="cta"
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

    <template v-else-if="isSubscribed">
      <IonButton expand="block" class="cta" :strong="true" @click="emit('manage')">
        {{ $t("settings.subscription.manage") }}
      </IonButton>
    </template>

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

    <IonNote class="legal">
      <a v-for="doc in legalDocuments" :key="doc.title" :href="doc.link" target="_blank">
        {{ doc.title }}
      </a>
    </IonNote>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { IonButton, IonIcon, IonItem, IonLabel, IonNote } from "@ionic/vue"
import { checkmarkCircle } from "ionicons/icons"

export interface PackageView {
  packageId: string
  priceString: string
  billingPeriod: string
}

export interface LegalDocumentView {
  title: string
  link: string
}

const props = defineProps<{
  packages: PackageView[]
  isSubscribed: boolean
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
.footer {
  padding: 12px 0 8px;
  background: var(--ion-background-color);
  border-top: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
}

.plan {
  margin: 0 16px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.cta {
  margin: 12px 16px 4px;
  --box-shadow: none;
}

.cant-pay {
  margin: 0 16px;
  --box-shadow: none;
  font-size: 0.9rem;
}

.legal {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-evenly;
  gap: 0.5rem;
  padding: 12px 16px 8px;
}

.legal a {
  color: var(--ion-color-medium);
  text-decoration: none;
  font-size: 0.9rem;
}
</style>
