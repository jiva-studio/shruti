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
        // Single route for the chat screen. The active session rides in
        // a `?session=<id>` QUERY param, NOT a path param. This is
        // deliberate: Ionic's IonRouterOutlet keys views by matched
        // route + pathname, and treats a parameterised path
        // (`chat/:sessionId`) as a brand-new view per id — so opening a
        // session would tear down and re-mount ChatView with a full
        // page-push transition (the source of the "tap chat → it opens,
        // scrolls, then bounces back" flicker). A query param keeps the
        // pathname stable at `/tabs/chat`, so the SAME ChatView instance
        // is reused and only its reactive `route.query.session` updates.
        path: "chat",
        name: "chat",
        component: () => import("@shruti/views/Chat/ChatView.vue"),
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@shruti/views/Settings/SettingsView.vue"),
      },
      {
        path: "subscription",
        name: "subscription",
        component: () => import("@shruti/views/Subscription/SubscriptionView.vue"),
      },
      {
        path: "track/:trackId",
        name: "track",
        component: () => import("@shruti/views/Track/TrackView.vue"),
        props: true,
      },
      {
        path: "search/collection/:id",
        name: "collection",
        component: () => import("@shruti/views/Collection/CollectionView.vue"),
        props: (route) => ({ id: route.params.id, kind: "collection" }),
      },
      {
        path: "search/collection-group/:groupId",
        name: "collection-group",
        component: () => import("@shruti/views/Collection/CollectionListView.vue"),
        props: true,
      },
      {
        path: "search/topic/:topicId",
        name: "topic-tracks",
        component: () => import("@shruti/views/Collection/CollectionView.vue"),
        props: (route) => ({ id: route.params.topicId, kind: "topic" }),
      },
      {
        path: "search/collections",
        name: "collections",
        component: () => import("@shruti/views/Collection/CollectionListView.vue"),
      },
      {
        path: "search/tracks",
        name: "tracks",
        component: () => import("@shruti/views/Tracks/TracksView.vue"),
      },
      {
        // Single route for both Note-edit and Citation modes. Entry
        // points (NotesView, CitationChip) hand off the payload via
        // `useStudioHandoffStore` and then push here.
        path: "studio",
        name: "studio",
        component: () => import("@shruti/views/Studio/StudioView.vue"),
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
// `/tabs/chat?session=<id>` via deep link or Ask Sadhu without ever
// visiting `/tabs/chat`), the first entry IS the current entry — delta = 0.
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
