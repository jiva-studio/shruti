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
    <OpenTranscriptAutomaticallySettingsItem />

    <!-- Social -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.misc') }}</IonLabel>
    </IonListHeader>
    <SocialNetworksSettingsItem />
  </Page>
</template>

<script setup lang="ts">
import { IonListHeader, IonLabel } from '@ionic/vue'
import { Page } from '@lectorium/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@lectorium/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@lectorium/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@lectorium/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@lectorium/mobile/features/notes'
import { HighlightCurrentSentenceSettingsItem, OpenTranscriptAutomaticallySettingsItem } from '@lectorium/mobile/features/transcript'
import { SignInSettingsItem } from '@lectorium/mobile/features/app.auth'
import { SocialNetworksSettingsItem } from '@lectorium/mobile/features/app.settings.contacts'
</script>
