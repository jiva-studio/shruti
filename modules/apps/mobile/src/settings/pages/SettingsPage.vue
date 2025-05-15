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
import { Page } from '@lectorium/mobile/app'
import AppLanguageSettingsItem from '../containers/AppLanguageSettingsItem.vue'
import SubscriptionSettingsItem from '../containers/SubscriptionSettingsItem.vue'
</script>
