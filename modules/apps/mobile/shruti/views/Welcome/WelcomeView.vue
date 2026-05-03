<template>
  <IonPage>
    <IonContent :fullscreen="true" class="ion-padding">
      <div class="welcome-container">
        <div class="welcome-header">
          <img src="/app-icon.png" alt="" class="welcome-logo" />
          <IonText color="primary">
            <h1>Shruti</h1>
          </IonText>
        </div>

        <div class="welcome-status">
          <LoadingState
            v-if="!welcome.isError.value"
            :message="statusMessage"
            :progress="
              welcome.viewState.value === 'database:downloading'
                ? welcome.progress.value
                : undefined
            "
          />
          <IonText v-else color="danger">
            <p>{{ welcome.error.value }}</p>
          </IonText>
        </div>

        <div class="welcome-footer">
          <IonButton
            v-if="welcome.isError.value"
            expand="block"
            fill="solid"
            @click="welcome.onRetry"
          >
            {{ $t("welcome.retry") }}
          </IonButton>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonPage, IonContent, IonText, IonButton } from "@ionic/vue"
import { useWelcomeController } from "./WelcomeView.controller.js"
import { useStatusMessage } from "./composables/useStatusMessage.js"
import LoadingState from "./components/LoadingState.vue"

const welcome = useWelcomeController()
const statusMessage = useStatusMessage(welcome.viewState)
</script>

<style scoped>
.welcome-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.welcome-header {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  padding-bottom: 20px;
  gap: 16px;
}

.welcome-logo {
  width: 120px;
  height: 120px;
  border-radius: 24px;
}

.welcome-header h1 {
  font-size: 32px;
  font-weight: bold;
  margin: 0;
}

.welcome-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0 16px;
}

.welcome-status p {
  margin: 0;
  font-size: 16px;
  text-align: center;
}

.welcome-footer {
  flex: 1;
  display: flex;
  align-items: flex-start;
  padding-top: 40px;
}

.welcome-footer ion-button {
  width: 100%;
  --box-shadow: none;
}
</style>
