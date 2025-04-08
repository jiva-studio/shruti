import { createRouter, createWebHistory } from 'vue-router'
import { routes as inboxRoutes } from '@lectorium/admin/library/inbox'
import { routes as authRoutes } from '@lectorium/admin/auth'
import { useAuthTokens } from './auth'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      redirect: '/library/inbox',
    },
    ...authRoutes,
    ...inboxRoutes,
  ],
})

router.beforeEach(async (to, from, next) => {
  const authTokens = useAuthTokens()
  const isAuthenticated = !!authTokens.value?.accessToken

  if (!isAuthenticated && to.name !== 'signIn') {
    next({ name: 'signIn' })
  } else if (isAuthenticated && to.name === 'signIn') {
    next({ name: 'home' })
  } else {
    next()
  }
})

export default router
