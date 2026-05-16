<template>
  <IonPage>
    <IonHeader>
      <IonToolbar>
        <IonButtons slot="start">
          <IonBackButton default-href="/tabs/notes" />
        </IonButtons>
        <IonTitle>{{ $t("studio.title") }}</IonTitle>
      </IonToolbar>
    </IonHeader>

    <IonContent :fullscreen="true" class="ion-padding">
      <IonSpinner v-if="loading" class="loading" name="dots" />

      <template v-else-if="note">
        <IonText color="medium">
          <p class="hint">{{ $t("studio.hint") }}</p>
        </IonText>

        <IonItem lines="none" class="editor-item">
          <IonTextarea
            v-model="editedText"
            :auto-grow="true"
            :rows="6"
            :placeholder="$t('studio.placeholder')"
            :disabled="busy"
            label-placement="stacked"
            class="editor"
          />
        </IonItem>

        <IonButton
          expand="block"
          class="ion-margin-top"
          :disabled="busy || editedText.trim().length === 0"
          @click="onDownload"
        >
          <IonSpinner v-if="busy" slot="start" name="crescent" />
          <IconDownload v-else slot="start" :size="20" style="margin-inline-end: 8px" />
          {{ $t("studio.download") }}
        </IonButton>

        <IonText v-if="busy && status" color="medium" class="status">
          <p>{{ status }}</p>
        </IonText>
      </template>
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonPage,
  IonSpinner,
  IonText,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from "@ionic/vue"
import { IconDownload } from "@ui/icons/index.js"
import { useStudioController } from "./StudioView.controller.js"

const { loading, note, editedText, busy, status, onDownload } = useStudioController()
</script>

<style scoped>
.loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.hint {
  font-size: 0.85rem;
  margin: 0 0 0.5rem;
}

.editor-item {
  --background: var(--ion-color-step-50, var(--ion-color-light));
  border-radius: 8px;
  margin-bottom: 0.5rem;
}

.editor {
  font-size: 0.95rem;
}

.status {
  display: block;
  text-align: center;
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
</style>
