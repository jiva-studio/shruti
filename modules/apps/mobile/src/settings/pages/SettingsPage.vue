<template>
  <Page>
    <IonList>
      <AppLanguageSettingsItem />
    </IonList>
  </Page>
</template>

<script setup lang="ts">
import { IonList } from '@ionic/vue'
import { Page } from '@shruti/mobile/app'
import AppLanguageSettingsItem from '../containers/AppLanguageSettingsItem.vue'
</script>
