// Known violation: a UI module globs driven adapters.
export const fixture = import.meta.glob("../../infra/*/index.ts")
