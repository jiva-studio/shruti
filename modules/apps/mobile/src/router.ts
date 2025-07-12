import { createRouter, createWebHistory } from '@ionic/vue-router'
import { RouteRecordRaw } from 'vue-router'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    component: () => import('@shruti/mobile/pages/SplashPage.vue'),
  },
  {
    path: '/app/',
    component: () => import('@shruti/mobile/pages/AppMainPage.vue'),
    children: [
      {
        path: '',
        redirect: '/app/home'
      },
      {
        path: 'home',
        name: 'home',
        component: () => import('@shruti/mobile/pages/HomePage.vue')
      },
      {
        path: 'notes',
        name: 'notes',
        component: () => import('@shruti/mobile/pages/NotesPage.vue')
      },
      {
        path: 'search',
        name: 'search',
        component: () => import('@shruti/mobile/pages/SearchPage.vue')
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@shruti/mobile/pages/SettingsPage.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

export default router
