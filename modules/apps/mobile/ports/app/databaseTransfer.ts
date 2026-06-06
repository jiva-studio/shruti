/**
 * Port for exporting the user database to / importing from a file the user
 * can share, back up, or move between devices. Adapter selection (native
 * Filesystem + Share vs. web Blob download + IndexedDB write) happens at
 * composition-root level.
 *
 * The port lives in the shared kit (`@kit/infra`); re-exported here so app
 * code keeps importing it from `@ports/app`.
 */
export type { IDatabaseTransfer } from "@kit/infra"
