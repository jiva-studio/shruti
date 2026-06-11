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
</template>

<script setup lang="ts">
import { IonLabel, IonListHeader } from "@ionic/vue"
import { SettingsToggleItem } from "@kit/ui"
import { IconLanguageHiragana } from "@tabler/icons-vue"
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
</script>
