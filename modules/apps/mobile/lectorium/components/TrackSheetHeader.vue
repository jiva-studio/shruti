<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { IonButton } from "@ionic/vue"
import { IconX } from "@tabler/icons-vue"

defineProps<{
  title: string
  author: string | null
  metaParts: readonly { text: string; shrinkable: boolean }[]
}>()
defineEmits<{ close: [] }>()

const { t } = useI18n()
</script>

<template>
  <div class="sheet-header">
    <IonButton
      class="close-button"
      fill="clear"
      :aria-label="t('app.close')"
      @click="$emit('close')"
    >
      <IconX slot="icon-only" :size="16" />
    </IonButton>
    <div class="sheet-heading">
      <h2 class="sheet-title">{{ title }}</h2>
      <p v-if="author" class="author">{{ author }}</p>
      <p v-if="metaParts.length" class="meta">
        <!-- The venue is the only part allowed to shrink: a long institute
             name must not push the date and length out of view. -->
        <span v-for="(part, i) in metaParts" :key="i" :class="{ shrinkable: part.shrinkable }">
          {{ part.text }}
        </span>
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Floats over the scroll, the way the tab bar does: the text passes beneath it
   and fades out rather than stopping at a hard edge. The parent measures this
   height and reserves it as content padding. */
.sheet-header {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10;
  padding: 14px 16px 12px;
  pointer-events: none;
  /* Opaque under the whole heading, fading only across the padding strip
     below it. A percentage stop would start the fade under the text itself and
     let the scrolling body show through it. */
  background: linear-gradient(
    to bottom,
    rgba(var(--lectorium-fade-bg-rgb), 1) 0,
    rgba(var(--lectorium-fade-bg-rgb), 1) calc(100% - 12px),
    rgba(var(--lectorium-fade-bg-rgb), 0.85) calc(100% - 6px),
    rgba(var(--lectorium-fade-bg-rgb), 0) 100%
  );
}

.sheet-header > * {
  pointer-events: auto;
}

.sheet-heading {
  flex: 1;
  min-width: 0;
}

/* Inset from the header's own box, so the distance from the top and from the
   side is the same number and not two boxes' paddings added together. */
.close-button {
  position: absolute;
  top: 16px;
  right: 8px;
  z-index: 11;
  width: 26px;
  height: 26px;
  min-height: 26px;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  --padding-start: 0;
  --padding-end: 0;
  --border-radius: 50%;
  --background: var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
  --background-hover: var(--ion-color-step-150, rgba(0, 0, 0, 0.1));
  --color: var(--ion-color-medium, #777);
}

.close-button::part(native) {
  width: 26px;
  height: 26px;
  min-height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sheet-title {
  margin: 4px 0 2px;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  /* Only the title runs alongside the close button, so only the title keeps
     clear of it. Reserving the gap on the whole header cut the meta line short
     under empty space. */
  padding-right: 36px;
}

.author {
  margin: 0;
  font-size: 14px;
  color: var(--ion-color-medium, #777);
}

/* One line, always. A long venue name would otherwise wrap and push the length
   onto a line of its own, which reads as a stray third fact. */
.meta {
  display: flex;
  align-items: baseline;
  margin: 2px 0 0;
  font-size: 13px;
  color: var(--ion-color-medium, #777);
  white-space: nowrap;
  overflow: hidden;
}

.meta > span {
  flex: 0 0 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meta > span.shrinkable {
  flex: 0 1 auto;
  min-width: 3em;
}

/* Spaces inside `content` collapse between flex items, so the gap around the
   separator is set as padding rather than written into the string. */
.meta > span + span::before {
  content: "·";
  padding: 0 0.4em;
}
</style>
