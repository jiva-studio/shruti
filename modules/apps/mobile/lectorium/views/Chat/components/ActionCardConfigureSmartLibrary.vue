<template>
  <ActionCardShell
    :show="!!payload"
    :state="state"
    :title="$t('chat.actionConfigureSmartLibraryTitle')"
    :confirm-label="$t('chat.actionConfigureSmartLibraryConfirm')"
    :done-label="$t('chat.actionConfigureSmartLibraryDone')"
    :error-label="$t('chat.actionConfigureSmartLibraryError')"
    @confirm="emit('confirm', actionId)"
  >
    <p class="body">{{ $t("chat.actionConfigureSmartLibraryBody") }}</p>
    <div v-if="hasFilters" class="filter-chips">
      <span v-for="(label, idx) in filterChips" :key="idx" class="chip">{{ label }}</span>
    </div>
  </ActionCardShell>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import ActionCardShell from "./ActionCardShell.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

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
</script>

<style scoped>
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
</style>
