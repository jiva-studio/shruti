<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.debug") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    :title="$t('settings.debug.viewLogs.title')"
    :subtitle="$t('settings.debug.viewLogs.description', { count })"
    @activate="emit('viewLogs')"
  >
    <template #icon>
      <IconChip><TranscriptIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <SettingsActionItem
    danger
    :title="$t('settings.danger.clearCache.title')"
    :subtitle="$t('settings.danger.clearCache.description')"
    @activate="emit('clearCache')"
  >
    <template #icon>
      <IconChip danger><ArchiveIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- Dev-only: force the subscription state so paywalled surfaces (incl. the
       onboarding paywall) are reviewable without a real purchase. -->
  <IonItem lines="none">
    <IonLabel>Subscription</IonLabel>
    <IonSegment
      :value="subscriptionOverride"
      data-testid="dev-subscription"
      @ionChange="onOverrideChange"
    >
      <IonSegmentButton value="default"><IonLabel>Default</IonLabel></IonSegmentButton>
      <IonSegmentButton value="pro"><IonLabel>Pro</IonLabel></IonSegmentButton>
      <IonSegmentButton value="free"><IonLabel>Free</IonLabel></IonSegmentButton>
    </IonSegment>
  </IonItem>
</template>

<script setup lang="ts">
import {
  IonItem,
  IonLabel,
  IonListHeader,
  IonSegment,
  IonSegmentButton,
  type SegmentChangeEventDetail,
} from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { ArchiveIcon, TranscriptIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{
  /** Number of buffered log lines — shown in the "View logs" subtitle. */
  count: number
  /** Current dev subscription override; the parent owns the state. */
  subscriptionOverride: string
}>()

const emit = defineEmits<{
  viewLogs: []
  clearCache: []
  setSubscription: [value: "default" | "pro" | "free"]
}>()

function onOverrideChange(e: CustomEvent<SegmentChangeEventDetail>): void {
  const v = e.detail.value
  if (v === "default" || v === "pro" || v === "free") emit("setSubscription", v)
}
</script>
