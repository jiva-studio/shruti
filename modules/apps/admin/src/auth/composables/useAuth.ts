import { ref, computed } from 'vue'
import { createGlobalState, useStorage } from '@vueuse/core'

export type User = {
  id: string
  email: string
}

export type Credentials = {
  accessToken: string
  refreshToken: string
}

export const useAuth = createGlobalState(() => {
  const authTokens = useAuthTokens()
  const user = ref({})
  const isAuthenticated = computed(() => !!authTokens.value.accessToken)

  function signIn(userData: User) {
    user.value = userData
  }

  return {
    isAuthenticated,
    signIn,
    user,
  }
})

export const useAuthTokens = createGlobalState(() =>
  useStorage(
    'authTokens',
    {
      accessToken: '',
      refreshToken: '',
    },
    localStorage,
    {
      serializer: {
        read: (value) => JSON.parse(value),
        write: (value) => JSON.stringify(value),
      },
    },
  ),
)
