<template>
  <IonItem
    lines="none"
    @click="goTonavigationPath"
  >
    {{ $t('home.playlistIsEmpty') }}
    <IonIcon
      slot="end"
      aria-hidden="true"
      color="primary"
      :icon="addCircle"
    />
  </IonItem>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { IonItem, IonIcon } from '@ionic/vue'
import { addCircle } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const router = useRouter()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  navigationPath: string
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function goTonavigationPath() {
  router.replace({ name: props.navigationPath })
}
</script>