<template>
  <OtpValidateForm
    v-model="otp"
    :is-invalid="isOptInvalid"
    :is-in-progress="isInProgress"
    @validate="onSignInButtonClicked"
  />
</template>

<script setup lang="ts">
import { ref, toRefs } from 'vue'
import { useAuthService, OtpValidateForm } from '@lectorium/admin/auth'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const authService = useAuthService()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  login: string
}>()

const emit = defineEmits<{
  authenticated: [accessToken: string, refreshToken: string]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { login } = toRefs(props)
const isInProgress = ref(false)
const isOptInvalid = ref(false)
const otp = ref('')

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onSignInButtonClicked() {
  try {
    isInProgress.value = true
    const credentials = await authService.signInWithOtp({
      login: login.value,
      otp: otp.value,
    })
    emit('authenticated', credentials.accessToken, credentials.refreshToken)
  } catch {
    isOptInvalid.value = true
  } finally {
    isInProgress.value = false
  }
}
</script>

<style scoped>
.p-inputotp {
  justify-content: space-between !important;
}
</style>
