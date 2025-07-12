import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    component: () => import('@lectorium/mobile/pages/SplashPage.vue'),
  },
  {
    path: '/app/',
    component: () => import('@lectorium/mobile/pages/AppMainPage.vue'),
    children: [
      {
        path: '',
        redirect: '/app/home'
      },
      {
        path: 'home',
        name: 'home',
        component: () => import('@lectorium/mobile/pages/HomePage.vue')
      },
      {
        path: 'notes',
        name: 'notes',
        component: () => import('@lectorium/mobile/pages/NotesPage.vue')
      },
      {
        path: 'search',
        name: 'search',
        component: () => import('@lectorium/mobile/pages/SearchPage.vue')
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@lectorium/mobile/pages/SettingsPage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router
