<template>
  <Page>
    <!-- App Appearance -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.appearance') }}</IonLabel>
    </IonListHeader>
    <AppLanguageSettingsItem />
    <ShowPlayerProgressSettingsItem />
    <ShowNotesTabSettingsItem />

    <!-- Pro Features -->
    <IonListHeader>
      <IonLabel>{{ $t('settings.groups.pro') }}</IonLabel>
    </IonListHeader>
    <SubscriptionSettingsItem />
  </Page>
</template>

<script setup lang="ts">
import { IonListHeader, IonLabel } from '@ionic/vue'
import { Page } from '@shruti/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@shruti/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@shruti/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@shruti/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@shruti/mobile/features/notes'
</script>
