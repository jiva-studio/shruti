<template>
  <IonItem lines="none">
    <div slot="start">
      🔗
    </div>
    <IonLabel>
      <h2>{{ $t('settings.social.socialNetworks') }}</h2>
      <p>{{ $t('settings.social.stayConnected') }}</p>
    </IonLabel>
    <div slot="end">
      <a href="https://t.me/akd_studios">
        <IconTelegram class="icon" />
      </a>
      <a href="https://www.facebook.com/groups/akd.studios/">
        <IconFacebook class="icon" />
      </a>
      <a href="https://vk.com/akd.studios">
        <IconVk class="icon" />
      </a>
    </div>
  </IonItem>
</template>


<script setup lang="ts">
import { IonLabel, IonItem } from '@ionic/vue'
import { IconTelegram } from '@shruti/mobile/features/app.ui.kit'
import { IconFacebook } from '@shruti/mobile/features/app.ui.kit'
import { IconVk } from '@shruti/mobile/features/app.ui.kit'
</script>


<style scoped>
.icon {
  width: 32px;
  height: 32px;
  margin: 6px;
}
</style>