<script setup lang="ts">
import { computed } from "vue"
import { IonLabel, IonListHeader } from "@ionic/vue"
import { useI18n } from "vue-i18n"
import { SettingsActionItem } from "@kit/ui"
import { MailIcon, StudioIcon, TelegramIcon, VkIcon } from "@ui/icons/index.js"
import { IconChip } from "@ui/primitives/index.js"

const emit = defineEmits<{
  "open-studio": []
  "open-email": []
  "open-vk": []
  "open-telegram": []
}>()
const { locale } = useI18n()
const isRussian = computed(() => (locale.value as string) === "ru")
</script>

<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.contacts") }}</IonLabel>
  </IonListHeader>

  <!-- Studio website — first in the group. Opens jiva.studio in the system
       browser so listeners can discover our other apps. -->
  <SettingsActionItem
    :title="$t('settings.contacts.studio.title')"
    :subtitle="$t('settings.contacts.studio.description')"
    @activate="emit('open-studio')"
  >
    <template #icon>
      <IconChip><StudioIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- Plain support email, available in every locale. Opens a bare mailto
       (subject + intro only) — NO logs / system state. The diagnostics email
       that attaches logs lives in the Debug group, not here. -->
  <SettingsActionItem
    :title="$t('settings.contacts.email.title')"
    :subtitle="$t('settings.contacts.email.description')"
    @activate="emit('open-email')"
  >
    <template #icon>
      <IconChip><MailIcon /></IconChip>
    </template>
  </SettingsActionItem>

  <!-- VK and Telegram are Russian-audience communities; only surface them in
       the ru locale. -->
  <template v-if="isRussian">
    <SettingsActionItem
      :title="$t('settings.contacts.vk.title')"
      :subtitle="$t('settings.contacts.vk.description')"
      @activate="emit('open-vk')"
    >
      <template #icon>
        <IconChip><VkIcon /></IconChip>
      </template>
    </SettingsActionItem>

    <SettingsActionItem
      :title="$t('settings.contacts.telegram.title')"
      :subtitle="$t('settings.contacts.telegram.description')"
      @activate="emit('open-telegram')"
    >
      <template #icon>
        <IconChip><TelegramIcon /></IconChip>
      </template>
    </SettingsActionItem>
  </template>
</template>
