<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { ArchiveIcon, MailIcon, TranscriptIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

defineProps<{
  /** Number of buffered log lines — shown in the "View logs" subtitle. */
  count: number
}>()

const emit = defineEmits<{
  "view-logs": []
  "email-diagnostics": []
  "clear-cache": []
}>()
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.debug") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    :title="$t('settings.debug.viewLogs.title')"
    :subtitle="$t('settings.debug.viewLogs.description', { count })"
    @activate="emit('view-logs')"
  >
    <template #icon>
      <IconChip><TranscriptIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- Diagnostics email: opens the mail client pre-filled with system state +
       a tail of the in-app log. Developer affordance — only reachable here, in
       the unlocked Debug group, never in the user-facing Contacts group. -->
  <SettingsActionItem
    :title="$t('settings.debug.email.title')"
    :subtitle="$t('settings.debug.email.description')"
    @activate="emit('email-diagnostics')"
  >
    <template #icon>
      <IconChip><MailIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <SettingsActionItem
    danger
    :title="$t('settings.danger.clearCache.title')"
    :subtitle="$t('settings.danger.clearCache.description')"
    @activate="emit('clear-cache')"
  >
    <template #icon>
      <IconChip danger><ArchiveIcon /></IconChip>
    </template>
  </SettingsActionItem>
</template>
