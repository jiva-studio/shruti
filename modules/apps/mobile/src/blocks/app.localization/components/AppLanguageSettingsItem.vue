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
import { ListItemSelectorDialog } from '@blocks/app.ui.selectors'
import { useConfig } from '@blocks/app.config'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  items: { id: string, title: string }[]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const open = ref(false)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onSelect(value?: string) {
  if (!value) return
  config.appLanguage.value = value
}
</script>