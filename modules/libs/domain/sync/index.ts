/**
 * Barrel for the domain-side profile-sync primitives: the HLC value object,
 * the shared sync document/collection types, and the per-collection merge
 * rules. Pure `@lib/domain` — no infra, no transport.
 */
export * from "./hlc.js"
export * from "./types.js"
export * from "./merge.js"
