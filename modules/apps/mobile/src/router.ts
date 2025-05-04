import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'
import { AppMainPage } from '@shruti/mobile/app'

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
        component: () => import('@shruti/mobile/home/pages/HomePage.vue')
      },
      {
        path: 'library',
        name: 'library',
        component: () => import('@shruti/mobile/library/pages/LibraryPage.vue')
      },
      {
        path: 'search',
        name: 'search',
        component: () => import('@shruti/mobile/search/pages/SearchPage.vue')
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@shruti/mobile/settings/pages/SettingsPage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router
