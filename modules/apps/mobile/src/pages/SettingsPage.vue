<template>
  <Page>
    <IonList>
      <AppLanguageSettingsItem />
      <SubscriptionSettingsItem />
    </IonList>
  </Page>
</template>

<script setup lang="ts">
import { IonList } from '@ionic/vue'
import { Page } from '@lectorium/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@lectorium/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@lectorium/mobile/features/app.localization'
</script>
