<template>
  <Page>
    <IonContent>
      <IonList>
        <AppLanguageSettingsItem />
        <IonItem>
          <IonLabel>
            <h2>API Url</h2>
            <p>{{ config.apiUrl }}</p>
          </IonLabel>
        </IonItem>
      </IonList>
    </IonContent>
  </Page>
</template>

<script setup lang="ts">
import { IonList, IonContent, IonItem, IonLabel } from '@ionic/vue'
import { Page } from '@/app/'
import AppLanguageSettingsItem from '../containers/AppLanguageSettingsItem.vue'
import { useConfig } from '@/app'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const config = useConfig()

</script>
