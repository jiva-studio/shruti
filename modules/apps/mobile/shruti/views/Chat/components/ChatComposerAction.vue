<script setup lang="ts">
import { IonSpinner } from "@ionic/vue"
import ChatSendButton from "@lib/ui/chat/ChatSendButton.vue"

defineProps<{ sending: boolean; disabled: boolean; hasText: boolean; label: string }>()
const emit = defineEmits<{ send: []; cancel: [] }>()
</script>

<template>
  <ChatSendButton
    :sending="sending"
    :disabled="disabled"
    :has-text="hasText"
    :label="label"
    @send="emit('send')"
    @cancel="emit('cancel')"
  >
    <template #spinner><IonSpinner name="dots" /></template>
  </ChatSendButton>
</template>
