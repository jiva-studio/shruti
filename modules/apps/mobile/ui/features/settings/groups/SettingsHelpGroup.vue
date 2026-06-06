<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.help") }}</IonLabel>
  </IonListHeader>

  <SettingsActionItem
    detail
    :title="$t('settings.help.open.title')"
    :subtitle="$t('settings.help.open.description')"
    @activate="emit('openHelp')"
  >
    <template #icon>
      <IconChip><HelpIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <SettingsActionItem
    detail
    :title="$t('settings.help.privacyPolicy.title')"
    :subtitle="$t('settings.help.privacyPolicy.description')"
    @activate="emit('openPrivacyPolicy')"
  >
    <template #icon>
      <IconChip><ShieldIcon /></IconChip>
    </template>
  </SettingsActionItem>
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsActionItem } from "@kit/ui"
import { HelpIcon, ShieldIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  openHelp: []
  openPrivacyPolicy: []
}>()
</script>
