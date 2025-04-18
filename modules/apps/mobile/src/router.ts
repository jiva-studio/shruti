import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'
import AppMainPage from '@/app/pages/AppMainPage.vue'

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
        component: () => import('@/home/pages/HomePage.vue')
      },
      {
        path: 'library',
        name: 'library',
        component: () => import('@/library/pages/LibraryPage.vue')
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/settings/pages/SettingsPage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router
