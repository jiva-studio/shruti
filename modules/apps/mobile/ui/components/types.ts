/**
 * UI mirror types for shared `ui/components`. The `ui/` layer must not import
 * domain types (enforced by eslint `no-restricted-imports`), so this declares
 * structurally-identical mirrors that the `lectorium/` layer's domain objects
 * are assignable to.
 */

/** Mirror of the domain `TrackOutlineChapter` (catalog outline entry). */
export interface UiOutlineChapter {
  readonly title: string
  readonly startMs: number
  readonly endMs: number
}
