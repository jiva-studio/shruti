// The catalog indexes under src/data/ are written by `npm run sync:all` from
// the published SQLite and are not committed. When a checkout has not synced
// them, these declarations stand in so type checking still passes; when the
// files exist, TypeScript reads them instead. Callers cast the value to the
// `@lib/catalog/types.js` shape either way.

declare module '*/data/lectures-index.json' {
  const value: unknown
  export default value
}

declare module '*/data/topics-index.json' {
  const value: unknown
  export default value
}

declare module '*/data/collections-index.json' {
  const value: unknown
  export default value
}

declare module '*/data/wisdom-index.json' {
  const value: unknown
  export default value
}
