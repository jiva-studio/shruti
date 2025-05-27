import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'
import { default as AppMainPage } from '@lectorium/mobile/pages/AppMainPage.vue'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    redirect: '/app/home'
  },
  {
    path: '/app/',
    component: AppMainPage,
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
