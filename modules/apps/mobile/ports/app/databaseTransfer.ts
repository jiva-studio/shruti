/**
 * Port for exporting the user database to / importing from a file the user
 * can share, back up, or move between devices. Adapter selection (native
 * Filesystem + Share vs. web Blob download + IndexedDB write) happens at
 * composition-root level.
 */
export interface IDatabaseTransfer {
  exportDatabase(): Promise<void>
  importDatabase(file: File): Promise<void>
}
