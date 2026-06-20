<template>
  <IonPage>
    <IonContent class="ion-padding">
      <!-- Placeholder shell — the carousel + 5 screens land in the next commit. -->
      <div class="onboarding-placeholder">
        <IonButton expand="block" @click="finish">Get started</IonButton>
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonButton, IonContent, IonPage, useIonRouter } from "@ionic/vue"
import { useOnboardingStore } from "@lectorium/stores/useOnboardingStore.js"

const ionRouter = useIonRouter()
const onboarding = useOnboardingStore()

async function finish(): Promise<void> {
  await onboarding.markCompleted()
  ionRouter.replace("/tabs/home")
}
</script>

<style scoped>
.onboarding-placeholder {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  min-height: 100%;
}
</style>
