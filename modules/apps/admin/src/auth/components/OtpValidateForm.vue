<template>
  <p class="mb-4 text-sm text-gray-500">
    {{ $t('auth.otp.enterOtpWeSentYou') }}
  </p>
  <InputOtp
    v-model="otp"
    size="large"
    class="mb-2 w-full"
    :length="6"
    :integer-only="true"
    :invalid="isInvalid"
    @keyup.enter="onInputComplete"
  />
  <Message v-if="isInvalid" severity="error" class="mb-2" size="small">
    {{ $t('auth.otp.unableToSignIn') }}
  </Message>
  <Button
    class="mt-2 w-full"
    :label="$t('auth.signIn')"
    :loading="isInProgress"
    @click="onInputComplete"
  />
</template>

<script setup lang="ts">
import { InputOtp, Button, Message } from 'primevue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  isInvalid: boolean
  isInProgress: boolean
}>()

const otp = defineModel<string>({ default: '' })

const emit = defineEmits<{
  validate: [otp: string]
}>()

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */
function onInputComplete() {
  emit('validate', otp.value)
}
</script>
