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
import { Page } from '@lectorium/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@lectorium/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@lectorium/mobile/features/app.localization'
import { ShowPlayerProgressSettingsItem } from '@lectorium/mobile/features/player.progress'
import { ShowNotesTabSettingsItem } from '@lectorium/mobile/features/notes'
</script>
