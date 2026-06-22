<template>
  <IonItem button detail lines="none" data-testid="settings-smart-library" @click="emit('click')">
    <IconChip slot="start">
      <IconDownload :size="22" />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>
        {{ $t("settings.smartLibrary.title") }}
        <ProBadge :label="$t('app.proBadge')" />
      </h2>
      <p>{{ subtitle }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import { IconDownload } from "@tabler/icons-vue"
import { IconChip, ProBadge } from "@ui/primitives/index.js"

defineProps<{ subtitle: string }>()

const emit = defineEmits<{ click: [] }>()
</script>
