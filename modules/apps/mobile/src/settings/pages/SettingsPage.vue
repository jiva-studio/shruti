<template>
  <Page>
    <IonList>
      <AppLanguageSettingsItem />
    </IonList>
  </Page>
</template>

<script setup lang="ts">
import { IonList } from '@ionic/vue'
import { Page } from '@lectorium/mobile/app'
import AppLanguageSettingsItem from '../containers/AppLanguageSettingsItem.vue'
</script>
