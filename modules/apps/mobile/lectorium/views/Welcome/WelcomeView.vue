<template>
  <IonPage>
    <IonContent :fullscreen="true" class="ion-padding">
      <div class="welcome-container">
        <!-- App name -->
        <div class="welcome-header">
          <IonText color="primary">
            <h1>Lectorium</h1>
          </IonText>
        </div>

        <!-- Status: loading or error message -->
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

        <!-- Retry button (only on error), pinned to bottom -->
        <div class="welcome-footer">
          <IonButton
            v-if="welcome.isError.value"
            expand="block"
            fill="solid"
            @click="welcome.onRetry"
          >
            Retry
          </IonButton>
        </div>
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IonPage, IonContent, IonText, IonButton } from "@ionic/vue"
import { useWelcomeController } from "./WelcomeView.controller.js"
import LoadingState from "./components/LoadingState.vue"

const welcome = useWelcomeController()

const STATUS_MESSAGES: Record<string, string> = {
  "server:probing": "Connecting to server…",
  "config:downloading": "Downloading configuration…",
  "database:check": "Checking database…",
  "database:downloading": "Downloading database…",
  "database:migrations": "Preparing database…",
}

const statusMessage = computed(() => STATUS_MESSAGES[welcome.viewState.value] ?? "Starting…")
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
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 20px;
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
