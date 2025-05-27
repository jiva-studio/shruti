<template>
  <IonItem
    button
    detail
    lines="none"
    @click="open = true"
  >
    <div slot="start">
      🌎
    </div>
    
    <IonLabel class="ion-text-nowrap">
      <h2>{{ $t('settings.appLanguage.title') }}</h2>
      <p>{{ $t('settings.appLanguage.description') }}</p>
    </IonLabel>
  </IonItem>
  <ListItemSelectorDialog 
    v-model:open="open"
    :value="config.appLanguage.value"
    :title="$t('settings.appLanguage.title')"
    :items="items"
    :allow-empty="false"
    @close="open = false"
    @select="onSelect"
  />
</template>


<script setup lang="ts">
import { ref } from 'vue'
import { IonItem, IonLabel } from '@ionic/vue'
import { useAsyncState } from '@vueuse/core'
import { ListItemSelectorDialog } from '@lectorium/mobile/features/app.ui.selectors'
import { useConfig } from '@lectorium/mobile/features/app.config'
import { useDAL } from '@lectorium/mobile/features/app.database'
import { useUserChangesAppLangSetting } from '../composables/useUserChangesAppLangSetting'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const dal = useDAL()
const config = useConfig()
const userChangesLang = useUserChangesAppLangSetting()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)
const { state: items } = useAsyncState(loadItems, [], { immediate: true, shallow: false })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect(value?: string) {
  if (!value) return
  userChangesLang.execute(value)
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

async function loadItems() {
  const allItems = await dal.languages.getAll()
  return allItems
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .map((item) => ({
      id: item._id.replace('language::', ''),
      title: item.icon + ' ' + item.fullName,
      checked: false,
    }))
    
}
</script>