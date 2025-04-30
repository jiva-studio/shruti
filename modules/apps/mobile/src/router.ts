import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'
import { AppMainPage } from '@lectorium/mobile/app'

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
        component: () => import('@lectorium/mobile/home/pages/HomePage.vue')
      },
      {
        path: 'library',
        name: 'library',
        component: () => import('@lectorium/mobile/library/pages/LibraryPage.vue')
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@lectorium/mobile/settings/pages/SettingsPage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router
