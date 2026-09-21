<script setup lang="ts">
import RowDivider from "@ui/components/RowDivider.vue"
import type { LegalDocumentView } from "./types.js"

/** Settings footer's Restore-purchases + legal links row (divider + stacked
 *  column). The onboarding paywall renders its own inline variant. */
const props = withDefaults(
  defineProps<{
    legalDocuments: LegalDocumentView[]
    restoring: boolean
    /** Hidden when there's nothing to restore. */
    showRestore?: boolean
  }>(),
  { showRestore: true }
)

const emit = defineEmits<{ restore: [] }>()

function onRestore(): void {
  if (props.restoring) return
  emit("restore")
}
</script>

<template>
  <div class="secondary">
    <RowDivider class="secondary-divider" />
    <div class="secondary-links">
      <a
        v-if="showRestore"
        class="secondary-link"
        role="button"
        tabindex="0"
        :class="{ 'is-busy': restoring }"
        @click="onRestore"
        @keydown.enter="onRestore"
      >
        {{ $t("settings.subscription.restore") }}
      </a>
      <a
        v-for="doc in legalDocuments"
        :key="doc.title"
        class="secondary-link"
        :href="doc.link"
        target="_blank"
      >
        {{ doc.title }}
      </a>
    </div>
  </div>
</template>

<style scoped>
.secondary {
  margin-top: 28px;
}
.secondary-divider {
  margin: 0 0 14px;
}
.secondary-links {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 0 0 12px;
}
.secondary-link {
  color: var(--ion-color-medium);
  text-decoration: none;
  font-size: 0.9rem;
  cursor: pointer;
}
.secondary-link.is-busy {
  opacity: 0.5;
  pointer-events: none;
}
</style>
