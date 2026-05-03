<template>
  <div class="status-section">
    <IonProgressBar v-if="progress !== undefined" :value="progress / 100" />
    <IonProgressBar v-else type="indeterminate" />
    <IonText color="medium">
      <p>{{ message }}</p>
    </IonText>
  </div>
</template>

<script setup lang="ts">
import { IonText, IonProgressBar } from "@ionic/vue"

interface Props {
  message: string
  progress?: number
}

defineProps<Props>()
</script>

<style scoped>
.status-section {
  margin-top: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  width: 260px;
}

.status-section p {
  margin: 0;
  font-size: 16px;
}

ion-progress-bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
}
</style>
