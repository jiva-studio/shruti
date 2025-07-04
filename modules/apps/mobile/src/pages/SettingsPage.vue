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
import { Page } from '@shruti/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@shruti/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@shruti/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@shruti/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@shruti/mobile/features/notes'
import { HighlightCurrentSentenceSettingsItem, OpenTranscriptAutomaticallySettingsItem } from '@shruti/mobile/features/transcript'
import { SignInSettingsItem } from '@shruti/mobile/features/app.auth'
import { SocialNetworksSettingsItem } from '@shruti/mobile/features/app.settings.contacts'
</script>
