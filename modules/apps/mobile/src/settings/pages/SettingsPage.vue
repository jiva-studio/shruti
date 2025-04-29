<template>
  <Page>
    <IonContent>
      <IonList>
        <AppLanguageSettingsItem />
      </IonList>
    </IonContent>
  </Page>
</template>

<script setup lang="ts">
import { IonList, IonContent } from '@ionic/vue'
import { Page } from '@/app/'
import AppLanguageSettingsItem from '../containers/AppLanguageSettingsItem.vue'
</script>
