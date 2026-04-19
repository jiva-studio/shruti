import { createRouter, createWebHistory } from "@ionic/vue-router"
import type { RouteRecordRaw } from "vue-router"

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/welcome" },
  {
    path: "/welcome",
    name: "welcome",
    component: () => import("@shruti/views/Welcome/WelcomeView.vue"),
  },
  {
    path: "/tabs/home",
    name: "home",
    component: () => import("@shruti/views/Home/HomeView.vue"),
  },
  {
    path: "/tabs/search",
    name: "search",
    component: () => import("@shruti/views/Search/SearchView.vue"),
  },
  {
    path: "/tabs/track/:trackId",
    name: "track",
    component: () => import("@shruti/views/Track/TrackView.vue"),
    props: true,
  },
  {
    path: "/tabs/notes",
    name: "notes",
    component: () => import("@shruti/views/Notes/NotesView.vue"),
  },
  {
    path: "/tabs/settings",
    name: "settings",
    component: () => import("@shruti/views/Settings/SettingsView.vue"),
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

export default router
