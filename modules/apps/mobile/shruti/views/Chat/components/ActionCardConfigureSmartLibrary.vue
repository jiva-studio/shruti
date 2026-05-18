<template>
  <section v-if="payload" class="action-card smart-library">
    <header class="head">
      <span class="name">{{ $t("chat.actionConfigureSmartLibraryTitle") }}</span>
    </header>
    <p class="body">{{ $t("chat.actionConfigureSmartLibraryBody") }}</p>
    <div v-if="hasFilters" class="filter-chips">
      <span v-for="(label, idx) in filterChips" :key="idx" class="chip">{{ label }}</span>
    </div>
    <footer class="footer">
      <span v-if="state === 'done'" class="hint">
        {{ $t("chat.actionConfigureSmartLibraryDone") }}
      </span>
      <span v-else-if="state === 'error'" class="hint error">
        {{ $t("chat.actionConfigureSmartLibraryError") }}
      </span>
      <button v-if="state === 'pending'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionConfigureSmartLibraryConfirm") }}
      </button>
      <button v-else-if="state === 'executing'" class="btn primary" disabled>
        <IonSpinner name="dots" class="spinner" />
      </button>
      <button v-else-if="state === 'error'" class="btn primary" @click="onConfirm">
        {{ $t("chat.actionRetry") }}
      </button>
    </footer>
  </section>
  <section v-else class="action-card smart-library broken">
    <span class="broken-icon">⚠</span>
    <span class="broken-text">{{ $t("chat.actionDegraded") }}</span>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { IonSpinner } from "@ionic/vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@shruti/stores/useChatStore.js"

const props = defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "configure_smart_library" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()

const { t } = useI18n()

const filterChips = computed(() => {
  const f = props.payload?.filters
  if (!f) return [] as string[]
  // Render counts rather than ids — the id-to-name resolution lives in
  // Settings; the card is a teaser, not the configuration UI itself.
  const chips: string[] = []
  if (f.authorIds && f.authorIds.length > 0)
    chips.push(t("chat.actionConfigureSmartLibraryChipAuthors", { n: f.authorIds.length }))
  if (f.tagIds && f.tagIds.length > 0)
    chips.push(t("chat.actionConfigureSmartLibraryChipTopics", { n: f.tagIds.length }))
  if (f.sourceIds && f.sourceIds.length > 0)
    chips.push(t("chat.actionConfigureSmartLibraryChipSources", { n: f.sourceIds.length }))
  if (f.locationIds && f.locationIds.length > 0)
    chips.push(t("chat.actionConfigureSmartLibraryChipLocations", { n: f.locationIds.length }))
  if (f.languageCodes && f.languageCodes.length > 0)
    chips.push(t("chat.actionConfigureSmartLibraryChipLanguages", { n: f.languageCodes.length }))
  return chips
})

const hasFilters = computed(() => filterChips.value.length > 0)

function onConfirm() {
  emit("confirm", props.actionId)
}
</script>

<style scoped>
.action-card.smart-library {
  margin: 8px 0;
  padding: 12px 14px;
  border-radius: 12px;
  border: 1px solid rgba(var(--ion-color-primary-rgb), 0.28);
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

.action-card.broken {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--ion-color-medium);
  border: 1px dashed rgba(var(--ion-color-medium-rgb, 146, 148, 156), 0.5);
  background: transparent;
}

.broken-icon {
  flex: 0 0 auto;
  opacity: 0.8;
}

.broken-text {
  flex: 1 1 auto;
  min-width: 0;
}

.head {
  margin-bottom: 4px;
}

.name {
  font-weight: 600;
  font-size: 15px;
}

.body {
  margin: 0 0 8px;
  font-size: 13px;
  color: var(--ion-color-medium);
  line-height: 1.35;
}

.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.chip {
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary);
}

.footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  min-height: 36px;
}

.btn {
  appearance: none;
  border: 0;
  border-radius: 10px;
  padding: 6px 14px;
  font-size: 13px;
  font-weight: 500;
  min-height: 30px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.btn.primary {
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
}

.btn.primary[disabled] {
  opacity: 0.6;
  cursor: default;
}

.spinner {
  width: 18px;
  height: 14px;
}

.hint {
  flex: 0 0 auto;
  font-size: 13px;
  padding: 6px 4px;
  opacity: 0.6;
}

.hint.error {
  color: var(--ion-color-danger, #eb445a);
  opacity: 0.85;
}
</style>
