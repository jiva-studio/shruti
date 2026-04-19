import { createRouter, createWebHistory } from "@ionic/vue-router"
import type { RouteRecordRaw } from "vue-router"

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/welcome" },
  {
    path: "/welcome",
    name: "welcome",
    component: () => import("@lectorium/views/Welcome/WelcomeView.vue"),
  },
  {
    path: "/tabs/home",
    name: "home",
    component: () => import("@lectorium/views/Home/HomeView.vue"),
  },
  {
    path: "/tabs/search",
    name: "search",
    component: () => import("@lectorium/views/Search/SearchView.vue"),
  },
  {
    path: "/tabs/track/:trackId",
    name: "track",
    component: () => import("@lectorium/views/Track/TrackView.vue"),
    props: true,
  },
  {
    path: "/tabs/notes",
    name: "notes",
    component: () => import("@lectorium/views/Notes/NotesView.vue"),
  },
  {
    path: "/tabs/settings",
    name: "settings",
    component: () => import("@lectorium/views/Settings/SettingsView.vue"),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

export default router
