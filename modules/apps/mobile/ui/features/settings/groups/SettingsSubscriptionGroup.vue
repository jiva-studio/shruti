<template>
  <template v-if="available">
    <IonListHeader>
      <IonLabel>{{ $t("settings.groups.subscription") }}</IonLabel>
    </IonListHeader>

    <IonItem
      v-if="isSubscribed"
      button
      :detail="true"
      lines="none"
      color="success"
      @click="emit('manage')"
    >
      <IconChip slot="start">
        <IconRosetteDiscountCheckFilled />
      </IconChip>
      <IonLabel class="ion-text-nowrap">
        <h2>{{ $t("settings.subscription.subscriptionIsActive") }}</h2>
        <p>{{ $t("settings.subscription.tapToManage") }}</p>
      </IonLabel>
    </IonItem>

    <IonItem v-else button :detail="true" lines="none" @click="open = true">
      <IconChip slot="start">
        <IconRosetteDiscountCheckFilled />
      </IconChip>
      <IonLabel class="ion-text-nowrap">
        <h2>{{ $t("settings.subscription.title") }}</h2>
        <p>{{ $t("settings.subscription.description") }}</p>
      </IonLabel>
    </IonItem>

    <SubscriptionDialog
      v-model:open="open"
      :packages="packages"
      :is-subscribed="isSubscribed"
      :purchasing="purchasing"
      :restoring="restoring"
      :legal-documents="legalDocuments"
      :debug-log="debugLog"
      @subscribe="(id) => emit('subscribe', id)"
      @restore="emit('restore')"
    />
  </template>
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { IconRosetteDiscountCheckFilled } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"
import SubscriptionDialog, {
  type LegalDocumentView,
  type SubscriptionPlanView,
} from "../SubscriptionDialog.vue"

defineProps<{
  available: boolean
  isSubscribed: boolean
  packages: SubscriptionPlanView[]
  purchasing: boolean
  restoring: boolean
  legalDocuments: LegalDocumentView[]
  debugLog?: string[]
}>()

const emit = defineEmits<{
  subscribe: [packageId: string]
  restore: []
  manage: []
}>()

const open = ref(false)
</script>
