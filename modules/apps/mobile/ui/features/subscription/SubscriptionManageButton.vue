<template>
  <IonButton expand="block" class="manage" :strong="true" @click="emit('manage')">
    {{ $t("settings.subscription.manage") }}
  </IonButton>
</template>

<script setup lang="ts">
import { IonButton } from "@ionic/vue"

const emit = defineEmits<{ manage: [] }>()
</script>

<style scoped>
.manage {
  margin: 0;
  --box-shadow: none;
  --border-radius: 12px;
}
</style>
