<template>
  <IonItem lines="none">
    <!-- Item Icon -->
    <div
      slot="start"
      class="settings-item-icon"
    >
      <LinksIcon />
    </div>

    <!-- Text -->
    <IonLabel>
      <h2>{{ $t('settings.contacts.socialNetworks.title') }}</h2>
      <p>{{ $t('settings.contacts.socialNetworks.description') }}</p>
    </IonLabel>

    <!-- Social Network Icons -->
    <div slot="end">
      <a href="https://t.me/shrutiapp">
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
import { IconTelegram } from '@blocks/app.ui.kit'
import { IconFacebook } from '@blocks/app.ui.kit'
import { IconVk } from '@blocks/app.ui.kit'
import LinksIcon from '../icons/LinksIcon.vue'
</script>


<style scoped>
.icon {
  width: 32px;
  height: 32px;
  margin: 6px;
}
</style>