<template>
  <IonItem button detail lines="none" data-testid="settings-track-info" @click="onClick">
    <IconChip slot="start">
      <BookIcon />
    </IconChip>

    <IonLabel class="ion-text-nowrap">
      <h2>
        {{ $t("settings.trackInfo.label") }}
        <ProBadge :label="$t('app.proBadge')" />
      </h2>
      <p>{{ $t("settings.trackInfo.description") }}</p>
    </IonLabel>
  </IonItem>
</template>

<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import { BookIcon } from "@ui/icons/index.js"
import { IconChip, ProBadge } from "@ui/primitives/index.js"

const props = defineProps<{ isSubscribed: boolean }>()
const emit = defineEmits<{ open: []; "request-paywall": [] }>()

function onClick(): void {
  if (props.isSubscribed) emit("open")
  else emit("request-paywall")
}
</script>
