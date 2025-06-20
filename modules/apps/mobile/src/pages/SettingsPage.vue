<template>
  <Page>
    <!-- App Appearance -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.appearance') }}</IonLabel>
    </IonListHeader>
    <AppLanguageSettingsItem />
    <ShowPlayerProgressSettingsItem />
    <ShowNotesTabSettingsItem />
    <HighlightCurrentSentenceSettingsItem />

    <!-- Pro Features -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.pro') }}</IonLabel>
    </IonListHeader>
    <SubscriptionSettingsItem />

    <!-- Social -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.misc') }}</IonLabel>
    </IonListHeader>
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
  </Page>
</template>

<script setup lang="ts">
import { IonListHeader, IonLabel, IonItem } from '@ionic/vue'
import { Page } from '@lectorium/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@lectorium/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@lectorium/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@lectorium/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@lectorium/mobile/features/notes'
import { HighlightCurrentSentenceSettingsItem } from '@lectorium/mobile/features/transcript'
import { IconTelegram } from '@lectorium/mobile/features/app.ui.kit'
import { IconFacebook } from '@lectorium/mobile/features/app.ui.kit'
import { IconVk } from '@lectorium/mobile/features/app.ui.kit'
</script>

<style scoped>
.icon {
  width: 32px;
  height: 32px;
  margin: 6px;
}
</style>