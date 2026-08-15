<template>
  <IonPage>
    <IonContent :fullscreen="true">
      <div class="storage-error" data-testid="storage-error">
        <IconDatabaseOff class="storage-error__icon" :size="56" :stroke-width="1.4" />
        <h1 class="storage-error__title">{{ $t("errors.storage.title") }}</h1>
        <p class="storage-error__text">{{ $t("errors.storage.description") }}</p>
        <p class="storage-error__text">{{ $t("errors.storage.advice") }}</p>
        <!-- The underlying message, verbatim. It is the one thing that makes a
             bug report about this actionable, and it cost nothing to keep. -->
        <p v-if="reason" class="storage-error__reason" data-testid="storage-error-reason">
          {{ reason }}
        </p>
        <IonButton
          expand="block"
          :strong="true"
          class="storage-error__retry"
          data-testid="storage-error-retry"
          :disabled="busy"
          @click="onRetry"
        >
          {{ $t("errors.storage.retry") }}
        </IonButton>
        <!-- The way out when retry can never work: a corrupt user database or
             a migration that fails the same way every launch. Settings is
             behind the router guard, so this screen has to carry it (#1831). -->
        <IonButton
          expand="block"
          fill="clear"
          color="danger"
          class="storage-error__reset"
          data-testid="storage-error-reset"
          :disabled="busy"
          @click="onReset"
        >
          {{ $t("errors.storage.reset.action") }}
        </IonButton>
        <p class="storage-error__text storage-error__hint">
          {{ $t("errors.storage.reset.hint") }}
        </p>
      </div>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonButton, IonContent, IonPage } from "@ionic/vue"
import { IconDatabaseOff } from "@tabler/icons-vue"
import { storageFailure } from "@shruti/services/storageHealth.js"
import { useStorageErrorActions } from "./useStorageErrorActions.js"

const reason = storageFailure()
const { busy, onRetry, onReset } = useStorageErrorActions()
</script>

<style scoped>
.storage-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100%;
  padding: 32px 24px;
  text-align: center;
  gap: 12px;
}

.storage-error__icon {
  color: var(--ion-color-medium);
  margin-bottom: 4px;
}

.storage-error__title {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
}

.storage-error__text {
  margin: 0;
  color: var(--ion-color-medium);
  font-size: 15px;
  line-height: 1.45;
}

.storage-error__reason {
  margin: 4px 0 0;
  color: var(--ion-color-medium);
  font-family: monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.storage-error__retry {
  align-self: stretch;
  margin-top: 20px;
}

.storage-error__reset {
  align-self: stretch;
  margin-top: 4px;
}

.storage-error__hint {
  font-size: 13px;
}
</style>
