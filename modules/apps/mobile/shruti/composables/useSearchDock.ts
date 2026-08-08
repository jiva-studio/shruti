import { computed, ref, type ComputedRef, type Ref } from "vue"
import router from "@shruti/router/index.js"

/**
 * The search field docked at the root: the words in it, and where it shows.
 *
 * One ref for the whole app, because there is one field — mounted in `App.vue`
 * beside the player so it stays above the pages the library tab pushes onto
 * itself. Every surface it floats over reads what it writes; a prop would not
 * cross the router outlet between them.
 *
 * Keyed to routes rather than to a page's lifetime: a tab view stays mounted
 * after you leave it, so a field tied to one would hang over Home.
 */
const text = ref<string>("")

/** The library tab and the two pages it pushes on top of itself. */
const DOCK_ROUTES = new Set(["search", "web-results", "my-library"])

export interface SearchDock {
  text: Ref<string>
  visible: ComputedRef<boolean>
}

export function useSearchDock(): SearchDock {
  // The router singleton, not `useRoute()`: this is called from `App.vue`,
  // where the injected route can still be unresolved at setup.
  const currentRoute = router.currentRoute
  return {
    text,
    visible: computed(() => DOCK_ROUTES.has(String(currentRoute.value.name))),
  }
}
