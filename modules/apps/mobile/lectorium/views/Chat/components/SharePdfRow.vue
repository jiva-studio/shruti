<script setup lang="ts">
import { computed } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconFileTypePdf } from "@tabler/icons-vue"
import type {
  ChatSharePdfItemPayload as SharePdfItemPayload,
  ChatSharePdfRefPayload as SharePdfRefPayload,
} from "@lib/domain/chatMessage.js"
import ScriptureChip from "@lib/ui/chat/ScriptureChip.vue"
import type { SharePdfRowState } from "./sharePdf.js"

const props = defineProps<{ item: SharePdfItemPayload; state: SharePdfRowState }>()
const emit = defineEmits<{ share: [] }>()

const meta = computed(() => [props.item.author, props.item.date].filter(Boolean).join(" · "))

// The server already resolved the source label, so this is "<short> <tokens>".
function refCaption(r: SharePdfRefPayload): string {
  const label = r.shortName ?? r.fullName ?? r.sourceId ?? ""
  return r.tokens ? `${label} ${r.tokens}`.trim() : label
}
</script>

<template>
  <li
    class="pdf-row"
    role="button"
    tabindex="0"
    :aria-disabled="state === 'sharing'"
    :data-state="state"
    @click="emit('share')"
    @keydown.enter.space.prevent="emit('share')"
  >
    <span class="pdf-icon" aria-hidden="true">
      <IonSpinner v-if="state === 'sharing'" name="dots" />
      <IconFileTypePdf v-else :size="32" :stroke-width="1.6" />
    </span>
    <div class="pdf-info">
      <span class="pdf-title">{{ item.title }}</span>
      <span v-if="item.references.length" class="pdf-refs">
        <ScriptureChip v-for="(r, i) in item.references" :key="i" :caption="refCaption(r)" />
      </span>
      <span v-if="meta" class="pdf-meta">{{ meta }}</span>
    </div>
  </li>
</template>

<style scoped>
.pdf-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 4px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 120ms ease;
}

/* Soft gradient divider, mirroring the VerseCard rules so action lists read
   consistently with verse cards. */
.pdf-row + .pdf-row {
  background-image: linear-gradient(
    to right,
    transparent,
    rgba(var(--ion-color-tertiary-rgb), 0.18),
    transparent
  );
  background-position: top;
  background-repeat: no-repeat;
  background-size: 100% 1px;
}

.pdf-row:active:not([aria-disabled="true"]) {
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}

.pdf-row[aria-disabled="true"] {
  cursor: default;
}

.pdf-row[data-state="shared"] .pdf-icon {
  opacity: 0.45;
}

.pdf-icon {
  flex: 0 0 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ion-color-primary);
  height: 40px;
}

.pdf-icon ion-spinner {
  --color: var(--ion-color-primary);
  height: 28px;
  width: 28px;
}

.pdf-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.pdf-title {
  /* Bubble prose size, so the row reads as part of the conversation rather
     than as an embedded widget. */
  font-size: 15px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--ion-text-color);
}

.pdf-refs {
  /* The chips carry their own pill styling; this lays them out, wrapping for
     a multi-verse lecture. The negative margin offsets the chip's own 2px
     side margin so it aligns with the title. */
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 2px 0 0 -2px;
}

.pdf-meta {
  font-size: 13px;
  line-height: 1.25;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
