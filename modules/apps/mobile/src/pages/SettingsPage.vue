<template>
  <Page>
    <!-- Account -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.auth') }}</IonLabel>
    </IonListHeader>
    <SignInSettingsItem />
    <SubscriptionSettingsItem />

    <!-- App Appearance -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.appearance') }}</IonLabel>
    </IonListHeader>
    <AppLanguageSettingsItem />
    <ShowPlayerProgressSettingsItem />
    <ShowNotesTabSettingsItem />
    <HighlightCurrentSentenceSettingsItem />

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
import { Page } from '@shruti/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@shruti/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@shruti/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@shruti/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@shruti/mobile/features/notes'
import { HighlightCurrentSentenceSettingsItem } from '@shruti/mobile/features/transcript'
import { SignInSettingsItem } from '@shruti/mobile/features/app.auth'
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