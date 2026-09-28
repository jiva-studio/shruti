// Known violation: the shared UI library reads row types through a relative
// path.
import type * as rows from "../persistence/main/index"

export type Fixture = typeof rows
