<template>
  <IonItem button detail lines="none" @click="open = true">
    <!-- Item Icon -->
    <div slot="start" class="settings-item-icon">
      <LanguageIcon />
    </div>

    <!-- Text -->
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t("settings.appLanguage.title") }}</h2>
      <p>{{ $t("settings.appLanguage.description") }}</p>
    </IonLabel>
  </IonItem>

  <!-- Language Selection Dialog -->
  <ListItemSelectorDialog
    v-model:open="open"
    :value="value"
    :title="$t('settings.appLanguage.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>

<script setup lang="ts">
import { ref } from "vue"
import { IonItem, IonLabel } from "@ionic/vue"
import { ListItemSelectorDialog } from "@ui/components/selectors/index.js"
import { LanguageIcon } from "@ui/icons/index.js"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  items: { id: string; title: string }[]
}>()

const value = defineModel<string>({ required: true, default: "en" })

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect(next?: string) {
  if (!next) return
  value.value = next
}
</script>
