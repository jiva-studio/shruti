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

    <IonItem v-else button :detail="true" lines="none" @click="emit('open-paywall')">
      <IconChip slot="start">
        <IconRosetteDiscountCheckFilled />
      </IconChip>
      <IonLabel class="ion-text-nowrap">
        <h2>{{ $t("settings.subscription.title") }}</h2>
        <p>{{ $t("settings.subscription.description") }}</p>
      </IonLabel>
    </IonItem>
  </template>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonListHeader } from "@ionic/vue"
import { IconRosetteDiscountCheckFilled } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{
  available: boolean
  isSubscribed: boolean
}>()

const emit = defineEmits<{
  "open-paywall": []
  manage: []
}>()
</script>
