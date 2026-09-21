<script lang="ts" setup>
import { IonButton } from "@ionic/vue"
import { IconBookmarkFilled, IconCopyFilled, IconShare, IconTrashFilled } from "@tabler/icons-vue"

/**
 * Popover mode:
 *  - `selection` (default): user drag-selected fresh text → Copy /
 *    Bookmark / Share / Ask. Bookmark is the dominant CTA, Delete is
 *    hidden.
 *  - `existing`: user tapped a span already covered by a saved note →
 *    Copy / Share / Ask / Delete. The Bookmark button is suppressed
 *    (the span is already a note) and a red Delete button is appended.
 */
type SelectionMode = "selection" | "existing"

withDefaults(
  defineProps<{
    mode?: SelectionMode
  }>(),
  { mode: "selection" }
)

const emit = defineEmits<{
  action: [action: "copy" | "bookmark" | "share" | "delete" | "ask"]
}>()
</script>

<template>
  <div class="selection-actions">
    <IonButton color="dark" size="small" fill="clear" @click="emit('action', 'copy')">
      <IconCopyFilled slot="start" :size="20" />
    </IonButton>
    <IonButton
      v-if="mode !== 'existing'"
      size="small"
      color="dark"
      fill="clear"
      @click="emit('action', 'bookmark')"
    >
      <IconBookmarkFilled slot="start" :size="20" />
    </IonButton>
    <IonButton size="small" color="dark" fill="clear" @click="emit('action', 'share')">
      <IconShare slot="start" :size="20" />
    </IonButton>
    <!-- Ask Sadhu — opens a focused chat anchored to this track with the
         selected fragment as the first focus message. Shown in BOTH
         modes: drag-select uses the live selection; tap-on-highlight
         ports the saved note's text into the focus card. The icon is
         inlined (rather than importing IconAppSadhu from views/) so
         this UI feature stays composition-root-free. -->
    <IonButton size="small" color="dark" fill="clear" @click="emit('action', 'ask')">
      <span slot="start" class="ask-icon-wrap">
        <img
          src="/agent-icon.png"
          alt="Ask"
          width="22"
          height="22"
          class="ask-icon-img"
          draggable="false"
        />
      </span>
    </IonButton>
    <IonButton
      v-if="mode === 'existing'"
      size="small"
      color="danger"
      fill="clear"
      @click="emit('action', 'delete')"
    >
      <IconTrashFilled slot="start" :size="20" />
    </IonButton>
  </div>
</template>

<style lang="css" scoped>
.selection-actions {
  display: flex;
  flex-direction: row;
  flex-grow: 1;
}

.button {
  flex-grow: 1;
  flex-basis: 1;
}

/* Sadhu icon inlined here (rather than borrowed from views/) so the
 * popover stays composition-root-free. Width/height kept loose so the
 * button hit-target matches its Tabler-icon siblings (which carry the
 * same :size="20"-ish glyph footprint). */
.ask-icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  background: rgba(var(--ion-color-primary-rgb), 0.1);
  padding: 1px;
}

.ask-icon-img {
  border-radius: 50%;
  display: block;
}
</style>
