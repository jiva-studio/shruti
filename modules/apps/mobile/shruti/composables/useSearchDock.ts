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
export type DockRoute = "search" | "web-results" | "my-library"

const DOCK_ROUTES = new Set<string>(["search", "web-results", "my-library"] satisfies DockRoute[])

export interface SearchDock {
  text: Ref<string>
  visible: ComputedRef<boolean>
  owns: (route: DockRoute) => ComputedRef<boolean>
}

export function useSearchDock(): SearchDock {
  // The router singleton, not `useRoute()`: this is called from `App.vue`,
  // where the injected route can still be unresolved at setup.
  const currentRoute = router.currentRoute
  return {
    text,
    visible: computed(() => DOCK_ROUTES.has(String(currentRoute.value.name))),
    /**
     * Is this the dock page on top — the one being typed into?
     *
     * The field is one ref for three routes, and a page underneath a pushed
     * one stays mounted and keeps watching it. Whoever searches on what it
     * holds has to ask first, or every page that has ever been open searches
     * at once and only the top one shows the answer.
     */
    owns: (route: DockRoute) => computed(() => String(currentRoute.value.name) === route),
  }
}
