<template>
  <p class="mb-4 text-sm text-gray-500">
    {{ $t('auth.otp.enterLoginToReceiveCode') }}
  </p>
  <InputText
    v-model="login"
    type="text"
    class="mb-2 w-full"
    :placeholder="$t('shared.email')"
    :invalid="isInvalid"
    @keyup.enter="onInputComplete"
  />
  <Message v-if="isInvalid" severity="error" class="mb-2" size="small">
    {{ $t('auth.otp.unableToRequestOtp') }}
  </Message>
  <Button
    class="mt-2 w-full"
    :label="$t('auth.otp.requestOtp')"
    :loading="isInProgress"
    @click="onInputComplete"
  />
</template>

<script setup lang="ts">
import { InputText, Button, Message } from 'primevue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  isInvalid: boolean
  isInProgress: boolean
}>()

const login = defineModel<string>({ default: '' })

const emit = defineEmits<{
  (e: 'request', login: string): void
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onInputComplete() {
  emit('request', login.value)
}
</script>
