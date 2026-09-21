<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { IonButton } from "@ionic/vue"
import { IconPlaylistAdd, IconReload, IconShare, IconTrash } from "@tabler/icons-vue"

defineProps<{
  isLibraryItem: boolean
  downloadFailed: boolean
  addDisabled: boolean
  primaryActionLabel: string
}>()
defineEmits<{ remove: []; share: []; primary: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="sheet-actions">
    <IonButton
      v-if="isLibraryItem"
      fill="clear"
      class="act icon-act remove-btn"
      :aria-label="t('library.remove')"
      @click="$emit('remove')"
    >
      <IconTrash slot="icon-only" :size="18" />
    </IonButton>
    <IonButton
      fill="clear"
      class="act icon-act share-btn"
      :aria-label="t('search.actions.share')"
      @click="$emit('share')"
    >
      <IconShare slot="icon-only" :size="18" />
    </IonButton>
    <IonButton class="act add-btn" :disabled="addDisabled" @click="$emit('primary')">
      <IconReload v-if="downloadFailed" slot="start" :size="18" />
      <IconPlaylistAdd v-else slot="start" :size="18" />
      {{ primaryActionLabel }}
    </IonButton>
  </div>
</template>

<style scoped>
/* The mirror of the header: the list runs under the buttons and fades into
   them, so the hard rule that used to cap the scroll is gone. */
.sheet-actions {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 28px 16px calc(10px + var(--ion-safe-area-bottom, 0px));
  background: linear-gradient(
    to top,
    rgba(var(--lectorium-fade-bg-rgb), 1) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 0.98) 60%,
    rgba(var(--lectorium-fade-bg-rgb), 0.6) 85%,
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

/* Quiet destructive action in the same button stack — a user-added lecture can
   be taken out of the personal library from its own sheet. Matches the share
   button's soft chrome, tinted danger. */
.remove-btn {
  --background: rgba(var(--ion-color-danger-rgb), 0.1);
  --background-hover: rgba(var(--ion-color-danger-rgb), 0.16);
  --color: var(--ion-color-danger);
}

.act {
  position: relative;
  margin: 0;
  --padding-start: 0;
  --padding-end: 0;
  --box-shadow: none;
}

/* The two secondary actions are squares on the left; the primary one takes
   whatever is left of the row. */
.icon-act {
  flex: 0 0 auto;
  width: 48px;
}

.add-btn {
  flex: 1;
  min-width: 0;
}

.act [slot="start"] {
  position: absolute;
  left: 9px;
  top: 50%;
  transform: translateY(-50%);
  margin: 0;
}

.share-btn {
  position: relative;
  /* Soft, light secondary button (no heavy outline) — sits quieter than the
     solid "add to playlist" primary action beside it. */
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
  --color: var(--ion-color-medium, #777);
}
</style>
