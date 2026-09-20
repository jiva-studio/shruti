/**
 * Minimal `vue-router` stub for the test runner.
 *
 * kit is router-agnostic, but `@ionic/vue`'s barrel statically imports a few
 * symbols from `vue-router` (which kit does not depend on). Aliasing those to
 * these inert stand-ins lets the Ionic-based settings components import under
 * jsdom without pulling a real router into kit's dependency graph.
 */
export const routeLocationKey = Symbol("routeLocationKey")
export const matchedRouteKey = Symbol("matchedRouteKey")
export function useRoute(): Record<string, unknown> {
  return {}
}
