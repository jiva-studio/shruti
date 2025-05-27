<template>
  <Page>
    <IonList>
      <AppLanguageSettingsItem />
      <SubscriptionSettingsItem v-if="isAndroid" />
    </IonList>
  </Page>
</template>

<script setup lang="ts">
import { IonList } from '@ionic/vue'
import { Page } from '@lectorium/mobile/features/app.core'
import { Capacitor } from '@capacitor/core'
import { SubscriptionSettingsItem } from '@lectorium/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@lectorium/mobile/features/app.localization'

const isAndroid = Capacitor.getPlatform() === 'android'
</script>
