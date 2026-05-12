package catalog

// SupportedDBScheme is the catalog DB schema version this binary is compiled
// against. Mirrors source/shruti/modules/db-scheme.json. If a downloaded
// snapshot reports a different scheme, catalog_refresh refuses with a
// clear error — rebuild the binary against the new scheme.
const SupportedDBScheme = 20260420
