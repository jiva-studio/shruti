<template>
  <OtpRequestForm
    v-model="login"
    :is-invalid="isDestinationInvalid"
    :is-in-progress="isInProgress"
    @request="onOtpRequested"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAuthService, OtpRequestForm } from '@lectorium/admin/auth'
import { OtpType } from '@lectorium/protocol'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const authService = useAuthService()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const emit = defineEmits<{
  (e: 'otp-requested', login: string): void
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isInProgress = ref(false)
const isDestinationInvalid = ref(false)
const login = defineModel<string>('login', { default: '' })

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onOtpRequested(login: string) {
  try {
    isInProgress.value = true
    await authService.requestOtp({
      type: OtpType.Email,
      destination: login,
    })
    emit('otp-requested', login)
  } catch {
    isDestinationInvalid.value = true
  } finally {
    isInProgress.value = false
  }
}
</script>
