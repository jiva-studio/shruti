<template>
  <IonListHeader>
    <IonLabel>{{ $t("settings.groups.chat") }}</IonLabel>
  </IonListHeader>

  <!-- Chat answer language. Empty value means "follow the interface
       language"; the read site falls back to appLanguage. -->
  <ChatLanguageSettingsItem v-model="chatLanguage" :items="languageItems" />

  <SettingsToggleItem
    v-model:checked="chatTranslateCitations"
    :title="$t('settings.chatTranslateCitations.title')"
    :subtitle="$t('settings.chatTranslateCitations.description')"
  >
    <template #icon>
      <IconChip><IconLanguageHiragana :size="22" /></IconChip>
    </template>
  </SettingsToggleItem>

  <!-- Sync chats across devices. Device-local, default on; gates whether
       Ask Sadhu conversations are synced to the profile service. -->
  <SettingsToggleItem
    v-model:checked="syncChats"
    :title="$t('settings.syncChats.title')"
    :subtitle="$t('settings.syncChats.description')"
  >
    <template #icon>
      <IconChip><IconRefresh :size="22" /></IconChip>
    </template>
  </SettingsToggleItem>
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsToggleItem } from "@kit/ui"
import { IconLanguageHiragana, IconRefresh } from "@tabler/icons-vue"
import { IconChip } from "@ui/primitives/index.js"
import ChatLanguageSettingsItem from "../ChatLanguageSettingsItem.vue"

interface SelectorItem {
  id: string
  title: string
}

defineProps<{
  languageItems: SelectorItem[]
}>()

const chatLanguage = defineModel<string>("chatLanguage", { required: true })
const chatTranslateCitations = defineModel<boolean>("chatTranslateCitations", { required: true })
const syncChats = defineModel<boolean>("syncChats", { required: true })
</script>
