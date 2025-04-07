import { createRouter, createWebHistory } from 'vue-router'
import { routes as inboxRoutes } from '@lectorium/admin/library/inbox'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      redirect: '/library/inbox',
    },
    ...inboxRoutes,
  ],
})

export default router
