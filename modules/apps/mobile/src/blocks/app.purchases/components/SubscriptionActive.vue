<template>
  <IonItem
    class="isle"
    :href="getManageSubscriptionsLink()"
    color="success"
    lines="none"
    :detail="true"
  >
    <div slot="start">
      👑  
    </div>
    <IonLabel>
      <h2>{{ $t('settings.subscription.subscriptionIsActive') }}</h2>
      <p>
        {{ $t('settings.subscription.tapToManage') }}
      </p>
    </IonLabel>
  </IonItem>
</template>

<script lang="ts" setup>
import { Capacitor } from '@capacitor/core'
import { IonItem, IonLabel } from '@ionic/vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  sku?: string
  packageId?: string
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

function getManageSubscriptionsLink() {
  const platform = Capacitor.getPlatform()

  if (platform === 'android') {
    if (!props.sku || !props.packageId) {
      return 'https://play.google.com/store/account/subscriptions'
    }
    return `https://play.google.com/store/account/subscriptions?sku=${props.sku}&package=${props.packageId}`
  } else if (platform === 'ios') {
    return 'https://apps.apple.com/account/subscriptions'
  } else {
    return ''
  }
}
</script>


<style scoped>
.isle {
  border-radius: 8px;
  margin: 1.5rem 0;
}
</style>