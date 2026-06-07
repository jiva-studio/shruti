<template>
  <ActionCardShell
    :show="!!payload"
    :state="state"
    accent="warning"
    :title="$t('chat.actionUpgradeToProTitle')"
    :confirm-label="$t('chat.actionUpgradeToProConfirm')"
    :done-label="$t('chat.actionUpgradeToProDone')"
    :error-label="$t('chat.actionUpgradeToProError')"
    @confirm="emit('confirm', actionId)"
  >
    <template #head-start>
      <span class="badge">PRO</span>
    </template>
    <p class="body">{{ $t("chat.actionUpgradeToProBody") }}</p>
  </ActionCardShell>
</template>

<script setup lang="ts">
import ActionCardShell from "./ActionCardShell.vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@shruti/stores/useChatStore.js"

defineProps<{
  actionId: string
  payload?: Extract<ChatActionPayload, { kind: "upgrade_to_pro" }>
  state: ActionState
}>()

const emit = defineEmits<{
  (e: "confirm", actionId: string): void
}>()
</script>

<style scoped>
.badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: var(--ion-color-warning, #ffc409);
  color: var(--ion-color-warning-contrast, #000);
}
</style>
