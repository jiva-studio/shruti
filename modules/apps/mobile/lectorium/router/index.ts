import { createRouter, createWebHistory } from "@ionic/vue-router"
import type { RouteRecordRaw } from "vue-router"
import { isLectoriumInitialized, useLectorium } from "@lectorium/lectorium.js"

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/welcome" },
  {
    path: "/welcome",
    name: "welcome",
    component: () => import("@lectorium/views/Welcome/WelcomeView.vue"),
  },
  {
    path: "/tabs/",
    component: () => import("@lectorium/views/TabsLayout.vue"),
    children: [
      { path: "", redirect: "/tabs/home" },
      {
        path: "home",
        name: "home",
        component: () => import("@lectorium/views/Home/HomeView.vue"),
      },
      {
        path: "search",
        name: "search",
        component: () => import("@lectorium/views/Search/SearchView.vue"),
      },
      {
        path: "notes",
        name: "notes",
        component: () => import("@lectorium/views/Notes/NotesView.vue"),
      },
      {
        path: "chat",
        name: "chat",
        component: () => import("@lectorium/views/Chat/ChatView.vue"),
      },
      {
        path: "chat/:sessionId",
        name: "chat-session",
        component: () => import("@lectorium/views/Chat/ChatView.vue"),
        props: true,
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@lectorium/views/Settings/SettingsView.vue"),
      },
      {
        path: "track/:trackId",
        name: "track",
        component: () => import("@lectorium/views/Track/TrackView.vue"),
        props: true,
      },
      {
        // Single route for both Note-edit and Citation modes. Entry
        // points (NotesView, CitationChip) hand off the payload via
        // `useStudioHandoffStore` and then push here.
        path: "studio",
        name: "studio",
        component: () => import("@lectorium/views/Studio/StudioView.vue"),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

// `@ionic/vue-router`'s `resetTab(tab)` runs when the user taps an
// already-active tab. It looks up the FIRST entry for that tab in the
// location history and calls `router.go(firstPos - currentPos)` to
// walk back. If the user landed directly on a child URL (e.g.
// `/tabs/chat/<id>` via deep link or Ask Sadhu without ever visiting
// `/tabs/chat`), the first entry IS the current entry — delta = 0.
// `router.go(0)` resolves to `history.go(0)`, which the browser
// treats as a full page reload. Intercept the degenerate case so the
// tap becomes a harmless no-op instead of nuking the SPA.
const originalGo = router.go.bind(router)
router.go = function patchedGo(delta: number): ReturnType<typeof originalGo> {
  if (delta === 0) return
  return originalGo(delta)
}

// Deep-linking guard: every non-welcome route depends on both databases
// being open. If someone lands on /tabs/* before the Welcome view has
// finished its initialize() cycle, bounce them to /welcome so the app
// doesn't explode inside `repositories()`.
//
// `isLectoriumInitialized()` is a second-line defence: the very first
// navigation fires synchronously from `router.install()`, before
// `app.mount()`. `main.ts` now calls `initLectorium()` before
// `app.use(router)` so this check is usually a no-op, but keeping it
// makes the guard robust to future reordering.
router.beforeEach((to, _from, next) => {
  if (to.path === "/welcome" || to.path === "/") return next()
  if (!isLectoriumInitialized()) return next()
  const app = useLectorium()
  if (!app.databases.content || !app.databases.user) {
    return next("/welcome")
  }
  next()
})

export default router
