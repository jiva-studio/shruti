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
import { Page } from '@shruti/mobile/features/app.core'
import { SubscriptionSettingsItem } from '@shruti/mobile/features/app.purchases'
import { AppLanguageSettingsItem } from '@shruti/mobile/features/app.localization'
</script>
