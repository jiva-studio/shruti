<template>
  <AuthLayout>
    <OtpRequest
      v-if="authStep === 'otp-request'"
      v-model:login="login"
      @otp-requested="onOtpRequested"
    />
    <SignInWithOtp
      v-if="authStep === 'otp-validate'"
      :login="login"
      @authenticated="onAuthenticated"
    />
  </AuthLayout>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  useAuth,
  useAuthTokens,
  AuthLayout,
  OtpRequest,
  SignInWithOtp,
} from '@lectorium/admin/auth'
import { useRouter } from 'vue-router'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const auth = useAuth()
const authTokens = useAuthTokens()
const router = useRouter()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const authStep = ref<'otp-request' | 'otp-validate'>('otp-request')
const login = ref('')

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

async function onOtpRequested() {
  authStep.value = 'otp-validate'
}

async function onAuthenticated(accessToken: string, refreshToken: string) {
  authTokens.value = { accessToken, refreshToken }
  auth.signIn({
    id: 'test',
    email: login.value,
  })
  router.replace({ name: 'home' })
}
</script>
