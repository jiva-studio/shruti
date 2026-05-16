import { createRouter, createWebHistory } from "@ionic/vue-router"
import type { RouteRecordRaw } from "vue-router"
import { isShrutiInitialized, useShruti } from "@shruti/shruti.js"

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/welcome" },
  {
    path: "/welcome",
    name: "welcome",
    component: () => import("@shruti/views/Welcome/WelcomeView.vue"),
  },
  {
    path: "/tabs/",
    component: () => import("@shruti/views/TabsLayout.vue"),
    children: [
      { path: "", redirect: "/tabs/home" },
      {
        path: "home",
        name: "home",
        component: () => import("@shruti/views/Home/HomeView.vue"),
      },
      {
        path: "search",
        name: "search",
        component: () => import("@shruti/views/Search/SearchView.vue"),
      },
      {
        path: "notes",
        name: "notes",
        component: () => import("@shruti/views/Notes/NotesView.vue"),
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@shruti/views/Settings/SettingsView.vue"),
      },
      {
        path: "track/:trackId",
        name: "track",
        component: () => import("@shruti/views/Track/TrackView.vue"),
        props: true,
      },
      {
        path: "studio/:noteId",
        name: "studio",
        component: () => import("@shruti/views/Studio/StudioView.vue"),
        props: true,
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// Deep-linking guard: every non-welcome route depends on both databases
// being open. If someone lands on /tabs/* before the Welcome view has
// finished its initialize() cycle, bounce them to /welcome so the app
// doesn't explode inside `repositories()`.
//
// `isShrutiInitialized()` is a second-line defence: the very first
// navigation fires synchronously from `router.install()`, before
// `app.mount()`. `main.ts` now calls `initShruti()` before
// `app.use(router)` so this check is usually a no-op, but keeping it
// makes the guard robust to future reordering.
router.beforeEach((to, _from, next) => {
  if (to.path === "/welcome" || to.path === "/") return next()
  if (!isShrutiInitialized()) return next()
  const app = useShruti()
  if (!app.databases.content || !app.databases.user) {
    return next("/welcome")
  }
  next()
})

export default router
