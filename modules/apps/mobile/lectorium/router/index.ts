import { createRouter, createWebHistory } from "@ionic/vue-router"
import type { RouteRecordRaw } from "vue-router"
import { isLectoriumInitialized, useLectorium } from "@lectorium/lectorium.js"
import { resolveDatabaseRedirect, STORAGE_ERROR_PATH } from "./databaseGuard.js"

const routes: RouteRecordRaw[] = [
  // Startup picks the real entry (onboarding vs Home) and replaces this before
  // mount; Home is the safe default for any stray navigation to "/".
  { path: "/", redirect: "/tabs/home" },
  {
    path: "/onboarding",
    name: "onboarding",
    component: () => import("@lectorium/views/Onboarding/OnboardingView.vue"),
  },
  {
    // Terminal screen for "the databases this app runs on are not open".
    // Deliberately outside /tabs — the tab bar's surfaces all read through
    // `repositories()`, which is exactly what is unavailable here.
    path: STORAGE_ERROR_PATH,
    name: "storage-error",
    component: () => import("@lectorium/views/StorageError/StorageErrorView.vue"),
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
        component: () => import("@lectorium/views/Chat/ChatView.vue"),
      },
      {
        path: "settings",
        name: "settings",
        component: () => import("@lectorium/views/Settings/SettingsView.vue"),
      },
      {
        path: "subscription",
        name: "subscription",
        component: () => import("@lectorium/views/Subscription/SubscriptionView.vue"),
      },
      {
        path: "track/:trackId",
        name: "track",
        component: () => import("@lectorium/views/Track/TrackView.vue"),
        props: true,
      },
      {
        path: "search/collection/:id",
        name: "collection",
        component: () => import("@lectorium/views/Collection/CollectionView.vue"),
        props: (route) => ({ id: route.params.id, kind: "collection" }),
      },
      {
        path: "search/collection-group/:groupId",
        name: "collection-group",
        component: () => import("@lectorium/views/Collection/CollectionListView.vue"),
        props: true,
      },
      {
        path: "search/topic/:topicId",
        name: "topic-tracks",
        component: () => import("@lectorium/views/Collection/CollectionView.vue"),
        props: (route) => ({ id: route.params.topicId, kind: "topic" }),
      },
      {
        path: "search/collections",
        name: "collections",
        component: () => import("@lectorium/views/Collection/CollectionListView.vue"),
      },
      {
        // The full set of what the archives turned up for a search — where the
        // "see all" on the library tab's internet shelf lands. The query rides
        // in `?q=`, so the page is a real address.
        path: "search/web",
        name: "web-results",
        component: () => import("@lectorium/views/Search/WebResultsView.vue"),
        props: (route) => ({
          initialQuery: typeof route.query.q === "string" ? route.query.q : "",
        }),
      },
      {
        // Personal library (epic #1236) — user-added lectures, NOT the corpus.
        // Named `my-library` to avoid colliding with the library-language /
        // landing "library" surfaces.
        path: "search/my-library",
        name: "my-library",
        // `?q=` narrows the same page to what a search matched, so the search
        // surface needs no second list of its own.
        component: () => import("@lectorium/views/Library/MyLibraryView.vue"),
        props: (route) => ({
          initialQuery: typeof route.query.q === "string" ? route.query.q : "",
        }),
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

// Deep-linking guard: every tabs route depends on both databases being open.
// Startup (`main.ts`) opens them headlessly before mount, so this is normally a
// no-op. When they are not open — a stray deep link arriving before startup
// settles, or a user DB that genuinely failed to open — the navigation lands on
// the storage-error screen, which is terminal and says what happened. See
// `databaseGuard.ts` for why it is not "/onboarding".
router.beforeEach((to, _from, next) => {
  const redirect = resolveDatabaseRedirect(to.path, {
    initialized: isLectoriumInitialized(),
    content: isLectoriumInitialized() && !!useLectorium().databases.content,
    user: isLectoriumInitialized() && !!useLectorium().databases.user,
  })
  if (redirect) return next(redirect)
  next()
})

export default router
